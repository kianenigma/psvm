// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! "Missed PRs": master PRs released on an older stable line that a newer stable line has in no release.
//!
//! A line has a PR released if a final release point of it contains a commit of its branch that mentions the PR number
//! (backports are titled `[stable2606] Backport #11910 (#13531)`). A newer line also has it if it branched off
//! `master` after the PR merged. A backport merged into a newer line but in none of its final releases leaves the line
//! missing the PR: its crates on crates.io still lack it (see `unpublished-backports.json`).

use super::{github::GitHub, parse, Cache, Error, SdkLine};
use futures::{stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A pull request mentioned on a release branch, cached by number once it is merged or closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MentionedPr {
    pub title: String,
    pub base: String,
    #[serde(rename = "mergedAt")]
    pub merged_at: Option<String>,
    pub state: String,
}

/// A master PR that some newer stable lines miss, as written to `missed-prs.json`.
#[derive(Debug, Serialize)]
pub struct MissedPr<'a> {
    pub number: u64,
    pub title: &'a str,
    #[serde(rename = "mergedAt")]
    pub merged_at: &'a str,
    /// Older lines and the first release of each that has it.
    pub released: Vec<LineRelease<'a>>,
    /// Newer lines that have it in no final release. Their branch may have a backport of it that is not released yet.
    pub missing: Vec<&'a str>,
}

#[derive(Debug, Serialize)]
pub struct LineRelease<'a> {
    pub line: &'a str,
    pub release: &'a str,
}

/// Per line: PR -> position of the oldest commit mentioning it, and the positions and ids of its final releases.
type LineIndex<'a> = (HashMap<u64, usize>, Vec<(usize, &'a str)>);

/// Stable lines with a real `YYMM` and a known branch-off, oldest first.
fn stable_lines(lines: &[SdkLine]) -> Vec<&SdkLine> {
    let mut stable: Vec<(u32, &SdkLine)> = lines
        .iter()
        .filter(|l| l.name.starts_with("stable") && l.branch_off.is_some())
        .filter_map(|l| Some((parse::line_month(&l.name, &l.releases.first()?.date)?, l)))
        .collect();
    stable.sort_by_key(|(month, _)| *month);
    stable.into_iter().map(|(_, l)| l).collect()
}

/// Every PR number mentioned on the stable branches.
pub fn mentioned_numbers(lines: &[SdkLine]) -> BTreeSet<u64> {
    stable_lines(lines)
        .iter()
        .flat_map(|l| l.history.iter().flat_map(|(_, prs)| prs.iter().copied()))
        .collect()
}

/// Looks up `numbers` with batched GraphQL queries, reusing cached merged or closed PRs.
pub async fn mentioned_prs(
    gh: &GitHub,
    cache: &Cache,
    numbers: &BTreeSet<u64>,
) -> Result<BTreeMap<u64, MentionedPr>, Error> {
    const BATCH: usize = 80;
    let mut prs = BTreeMap::new();
    let mut unknown = vec![];
    for &n in numbers {
        match cache.get::<MentionedPr>("pr", &n.to_string()) {
            Some(pr) => {
                prs.insert(n, pr);
            }
            None => unknown.push(n),
        }
    }
    let batches: Vec<Vec<u64>> = unknown.chunks(BATCH).map(<[u64]>::to_vec).collect();
    let fetched: Vec<Vec<(u64, MentionedPr)>> = stream::iter(batches)
        .map(|batch| async move {
            let fields = batch
                .iter()
                .map(|n| {
                    format!("p{n}: pullRequest(number: {n}) {{ title baseRefName mergedAt state }}")
                })
                .collect::<Vec<_>>()
                .join(" ");
            let query = format!(
                r#"{{ repository(owner: "paritytech", name: "polkadot-sdk") {{ {fields} }} }}"#
            );
            let data = gh.graphql(&query, serde_json::json!({})).await?;
            let repo = &data["repository"];
            let found = batch
                .iter()
                .filter_map(|n| {
                    let pr = &repo[format!("p{n}")];
                    Some((
                        *n,
                        MentionedPr {
                            title: pr["title"].as_str()?.to_string(),
                            base: pr["baseRefName"].as_str().unwrap_or_default().to_string(),
                            merged_at: pr["mergedAt"].as_str().map(String::from),
                            state: pr["state"].as_str().unwrap_or_default().to_string(),
                        },
                    ))
                })
                .collect();
            Ok::<_, Error>(found)
        })
        .buffer_unordered(4)
        .try_collect()
        .await?;
    for (n, pr) in fetched.into_iter().flatten() {
        if pr.state != "OPEN" {
            cache.put("pr", &n.to_string(), &pr)?;
        }
        prs.insert(n, pr);
    }
    log::info!(
        "{} PRs mentioned on release branches ({} looked up)",
        prs.len(),
        unknown.len()
    );
    Ok(prs)
}

/// Master PRs released on an older stable line but absent from some newer stable line, newest merge first.
pub fn missed_prs<'a>(
    lines: &'a [SdkLine],
    prs: &'a BTreeMap<u64, MentionedPr>,
) -> Vec<MissedPr<'a>> {
    let stable = stable_lines(lines);
    // Per line: PR -> position of the oldest commit mentioning it (history is newest first), and the positions of
    // the final release points.
    let per_line: Vec<LineIndex> = stable
        .iter()
        .map(|line| {
            let mut mentions = HashMap::new();
            for (position, (_, numbers)) in line.history.iter().enumerate() {
                for n in numbers {
                    mentions.insert(*n, position);
                }
            }
            let finals = line
                .releases
                .iter()
                .filter(|r| !r.rc)
                .filter_map(|r| {
                    Some((
                        line.history.iter().position(|(sha, _)| *sha == r.sha)?,
                        r.id.as_str(),
                    ))
                })
                .collect();
            (mentions, finals)
        })
        .collect();

    let mut missed: Vec<MissedPr> = prs
        .iter()
        .filter(|(_, pr)| pr.base == "master")
        .filter_map(|(&number, pr)| {
            let merged_at = pr.merged_at.as_deref()?;
            // Final releases at the commit's position or newer (smaller, history is newest first) contain it; the
            // oldest of them is the one with the largest position.
            let released: Vec<(usize, LineRelease)> = (0..stable.len())
                .filter_map(|i| {
                    let position = *per_line[i].0.get(&number)?;
                    let (_, release) = per_line[i]
                        .1
                        .iter()
                        .filter(|(q, _)| *q <= position)
                        .max_by_key(|(q, _)| *q)?;
                    Some((
                        i,
                        LineRelease {
                            line: &stable[i].name,
                            release,
                        },
                    ))
                })
                .collect();
            let oldest = released.first()?.0;
            let has = |i: usize| {
                released.iter().any(|(r, _)| *r == i)
                    || stable[i].branch_off.as_deref() > Some(merged_at)
            };
            let missing: Vec<&str> = (oldest + 1..stable.len())
                .filter(|&i| !has(i))
                .map(|i| stable[i].name.as_str())
                .collect();
            (!missing.is_empty()).then(|| MissedPr {
                number,
                title: &pr.title,
                merged_at,
                released: released.into_iter().map(|(_, r)| r).collect(),
                missing,
            })
        })
        .collect();
    missed.sort_by(|a, b| b.merged_at.cmp(a.merged_at));
    missed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{ReleaseKind, SdkRelease};

    fn line(
        name: &str,
        branch_off: &str,
        finals: &[(&str, &str)],
        history: &[(&str, &[u64])],
    ) -> SdkLine {
        SdkLine {
            name: name.into(),
            has_branch: true,
            releases: finals
                .iter()
                .map(|(id, sha)| SdkRelease {
                    id: id.to_string(),
                    name: id.to_string(),
                    kind: ReleaseKind::Tag,
                    sha: sha.to_string(),
                    date: branch_off.into(),
                    rc: false,
                    aliases: vec![],
                    publication: None,
                    source: None,
                    commits: None,
                })
                .collect(),
            branch_off: Some(branch_off.into()),
            history: history
                .iter()
                .map(|(sha, prs)| (sha.to_string(), prs.to_vec()))
                .collect(),
        }
    }

    fn pr(merged_at: &str) -> MentionedPr {
        MentionedPr {
            title: "fix".into(),
            base: "master".into(),
            merged_at: Some(merged_at.into()),
            state: "MERGED".into(),
        }
    }

    #[test]
    fn finds_prs_released_on_older_lines_only() {
        // stable2603 released the backport of #1 in stable2603-1 (commit "b", newest first: release "r1" is newer).
        let older = line(
            "stable2603",
            "2026-03-01T00:00:00Z",
            &[("stable2603-1", "r1")],
            &[("r1", &[]), ("b", &[1, 100])],
        );
        // stable2606 branched before #1 merged and has no backport of it, but has #2 via a backport.
        let newer = line(
            "stable2606",
            "2026-06-01T00:00:00Z",
            &[("stable2606", "r2")],
            &[("r2", &[]), ("c", &[2, 200])],
        );
        // #3 merged before stable2606 branched off, so stable2606 has it from master.
        let older = SdkLine {
            history: [older.history.clone(), vec![("d".into(), vec![2, 3])]].concat(),
            ..older
        };
        let lines = vec![older, newer];
        let prs = BTreeMap::from([
            (1, pr("2026-07-01T00:00:00Z")),
            (2, pr("2026-07-01T00:00:00Z")),
            (3, pr("2026-05-01T00:00:00Z")),
        ]);
        let missed = missed_prs(&lines, &prs);
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].number, 1);
        assert_eq!(missed[0].released[0].release, "stable2603-1");
        assert_eq!(missed[0].missing, vec!["stable2606"]);
    }

    #[test]
    fn a_merged_but_unreleased_backport_still_misses() {
        let older = line(
            "stable2606",
            "2026-06-01T00:00:00Z",
            &[("stable2606-2", "r1")],
            &[("r1", &[]), ("b", &[13059, 13072])],
        );
        // The backport `c` landed after stable2609-1, the line's latest final release.
        let newer = line(
            "stable2609",
            "2026-09-01T00:00:00Z",
            &[("stable2609-1", "r2")],
            &[("c", &[13059, 13755]), ("r2", &[])],
        );
        let lines = vec![older, newer];
        let prs = BTreeMap::from([(13059, pr("2026-09-02T18:22:25Z"))]);
        let missed = missed_prs(&lines, &prs);
        assert_eq!(missed.len(), 1);
        assert_eq!(missed[0].missing, vec!["stable2609"]);

        // Once a final release contains it, the line has it.
        let mut lines = lines;
        let next = SdkRelease {
            id: "stable2609-2".into(),
            sha: "r3".into(),
            ..lines[1].releases[0].clone()
        };
        lines[1].history.insert(0, ("r3".into(), vec![]));
        lines[1].releases.push(next);
        assert!(missed_prs(&lines, &prs).is_empty());
    }
}
