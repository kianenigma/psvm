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

//! "Unpublished backports": backports merged into a release line's branch after its latest final release point, so no
//! crates.io release of the line ships them yet.
//!
//! A branch commit is a backport if its title mentions both a PR into the line's branch (the backport itself) and a PR
//! into `master` (the original): `[stable2609 Backport #13059] Add sufficiency method (#13755)`.
//!
//! Each backport also lists the published crates its prdoc bumps. CI (`check-semver`) requires every crate a PR changes
//! to be in its prdoc, so a backport without one (a CI or docs change, usually labelled `R0-silent`) changes no crate and
//! needs no release.

use super::{
    github::GitHub,
    missed::MentionedPr,
    parse::{self, PrdocCrate},
    Cache, Error, SdkLine, CONCURRENCY, SDK_REPO,
};
use futures::{stream, StreamExt, TryStreamExt};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// A line's unpublished backports, as written to `unpublished-backports.json`.
#[derive(Debug, Serialize)]
pub struct UnpublishedLine<'a> {
    pub line: &'a str,
    /// Id of the line's latest final release point, which the backports came after; `None` if it has none yet.
    pub after: Option<&'a str>,
    /// Newest first.
    pub backports: Vec<UnpublishedBackport<'a>>,
}

#[derive(Debug, Serialize)]
pub struct UnpublishedBackport<'a> {
    pub sha: &'a str,
    /// The backport PR.
    pub number: u64,
    pub title: &'a str,
    #[serde(rename = "mergedAt")]
    pub merged_at: Option<&'a str>,
    /// The `master` PRs it backports.
    #[serde(rename = "backportOf")]
    pub backport_of: Vec<u64>,
    /// The published crates its prdoc bumps (other than `bump: none`), sorted; empty if it changes none. Set by
    /// [`add_crates`].
    pub crates: Vec<String>,
}

/// Branch commits, newest first: each commit's sha and the PR numbers its title mentions (as in [`SdkLine::history`]).
type Commits = [(String, Vec<u64>)];

/// The commits of a line's branch after its latest final release point (newest first), and that point's id. `None` if
/// the line has final releases but none of them is in its branch history, so the commits after them are unknown.
fn after_latest_final(line: &SdkLine) -> Option<(Option<&str>, &Commits)> {
    let finals: Vec<_> = line.releases.iter().filter(|r| !r.rc).collect();
    let latest = finals
        .iter()
        .filter_map(|r| {
            Some((
                line.history.iter().position(|(sha, _)| *sha == r.sha)?,
                r.id.as_str(),
            ))
        })
        .min_by_key(|(position, _)| *position);
    match latest {
        Some((position, id)) => Some((Some(id), &line.history[..position])),
        None if finals.is_empty() => Some((None, &line.history[..])),
        None => None,
    }
}

/// Every PR number mentioned by a branch commit after its line's latest final release point.
pub fn unpublished_numbers(lines: &[SdkLine]) -> BTreeSet<u64> {
    lines
        .iter()
        .filter(|l| l.has_branch)
        .filter_map(after_latest_final)
        .flat_map(|(_, commits)| commits.iter().flat_map(|(_, prs)| prs.iter().copied()))
        .collect()
}

/// Per line with a branch: the backports merged into it after its latest final release point.
pub fn unpublished_backports<'a>(
    lines: &'a [SdkLine],
    prs: &'a BTreeMap<u64, MentionedPr>,
) -> Vec<UnpublishedLine<'a>> {
    lines
        .iter()
        .filter(|l| l.has_branch)
        .filter_map(|line| {
            let (after, commits) = after_latest_final(line)?;
            let backports = commits
                .iter()
                .filter_map(|(sha, numbers)| {
                    let based_on = |base: &str| -> Vec<u64> {
                        numbers
                            .iter()
                            .copied()
                            .filter(|n| prs.get(n).is_some_and(|pr| pr.base == base))
                            .collect()
                    };
                    let number = *based_on(&line.name).first()?;
                    let backport_of = based_on("master");
                    if backport_of.is_empty() {
                        return None;
                    }
                    let pr = &prs[&number];
                    Some(UnpublishedBackport {
                        sha,
                        number,
                        title: &pr.title,
                        merged_at: pr.merged_at.as_deref(),
                        backport_of,
                        crates: vec![],
                    })
                })
                .collect();
            Some(UnpublishedLine {
                line: &line.name,
                after,
                backports,
            })
        })
        .collect()
}

/// Sets the `crates` of every backport from its prdoc at the backport commit. A backport carries the prdoc of the PR
/// it backports (`prdoc/pr_<original>.prdoc`); the backport's own number is tried too. Prdocs are cached by commit.
pub async fn add_crates<'a>(
    gh: &GitHub,
    cache: &Cache,
    lines: &mut [UnpublishedLine<'a>],
    published: &HashSet<&str>,
) -> Result<(), Error> {
    let numbers = |b: &UnpublishedBackport| -> Vec<u64> {
        b.backport_of.iter().copied().chain([b.number]).collect()
    };
    let wanted: BTreeSet<(&'a str, u64)> = lines
        .iter()
        .flat_map(|l| &l.backports)
        .flat_map(|b| numbers(b).into_iter().map(|n| (b.sha, n)))
        .collect();
    let prdocs: HashMap<(&str, u64), Vec<PrdocCrate>> = stream::iter(wanted)
        .map(|(sha, n)| async move {
            let key = format!("{sha}-{n}");
            if let Some(crates) = cache.get::<Vec<PrdocCrate>>("prdoc", &key) {
                return Ok(((sha, n), crates));
            }
            let crates = gh
                .raw(SDK_REPO, sha, &format!("prdoc/pr_{n}.prdoc"))
                .await?
                .map(|doc| parse::prdoc_crates(&doc))
                .unwrap_or_default();
            cache.put("prdoc", &key, &crates)?;
            Ok::<_, Error>(((sha, n), crates))
        })
        .buffer_unordered(CONCURRENCY)
        .try_collect()
        .await?;
    for backport in lines.iter_mut().flat_map(|l| l.backports.iter_mut()) {
        let found: Vec<&[PrdocCrate]> = numbers(backport)
            .iter()
            .map(|n| prdocs[&(backport.sha, *n)].as_slice())
            .collect();
        backport.crates = bumped_published(&found, published);
    }
    let silent = lines
        .iter()
        .flat_map(|l| &l.backports)
        .filter(|b| b.crates.is_empty())
        .count();
    log::info!("{silent} unpublished backports change no published crate");
    Ok(())
}

/// The published crates that `prdocs` bump (other than `bump: none`), sorted and deduplicated.
fn bumped_published(prdocs: &[&[PrdocCrate]], published: &HashSet<&str>) -> Vec<String> {
    let crates: BTreeSet<&str> = prdocs
        .iter()
        .flat_map(|crates| crates.iter())
        .filter(|c| c.bump.as_deref() != Some("none") && published.contains(c.name.as_str()))
        .map(|c| c.name.as_str())
        .collect();
    crates.into_iter().map(String::from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{ReleaseKind, SdkRelease};

    fn release(id: &str, sha: &str, rc: bool) -> SdkRelease {
        SdkRelease {
            id: id.into(),
            name: id.into(),
            kind: ReleaseKind::Tag,
            sha: sha.into(),
            date: "2026-11-01T00:00:00Z".into(),
            rc,
            aliases: vec![],
            publication: None,
            source: None,
            commits: None,
        }
    }

    fn pr(title: &str, base: &str) -> MentionedPr {
        MentionedPr {
            title: title.into(),
            base: base.into(),
            merged_at: Some("2026-11-09T09:28:02Z".into()),
            state: "MERGED".into(),
        }
    }

    #[test]
    fn lists_backports_after_the_latest_final_release() {
        let line = SdkLine {
            name: "stable2609".into(),
            has_branch: true,
            releases: vec![
                release("polkadot-stable2609-1", "r1", false),
                release("polkadot-stable2609-2-rc1", "rc", true),
            ],
            branch_off: None,
            // Newest first: a backport in an rc only, a spec bump, the latest final, an older backport.
            history: vec![
                ("rc".into(), vec![]),
                ("b".into(), vec![13059, 13755]),
                ("bump".into(), vec![13800]),
                ("r1".into(), vec![]),
                ("old".into(), vec![12000, 12001]),
            ],
        };
        let prs = BTreeMap::from([
            (13059, pr("Add sufficiency method", "master")),
            (
                13755,
                pr(
                    "[stable2609 Backport #13059] Add sufficiency method",
                    "stable2609",
                ),
            ),
            (13800, pr("[stable2609] Bump spec_version", "stable2609")),
            (12000, pr("Old fix", "master")),
            (
                12001,
                pr("[stable2609 Backport #12000] Old fix", "stable2609"),
            ),
        ]);
        let lines = vec![line];

        assert_eq!(
            unpublished_numbers(&lines),
            BTreeSet::from([13059, 13755, 13800])
        );
        let unpublished = unpublished_backports(&lines, &prs);
        assert_eq!(unpublished.len(), 1);
        assert_eq!(unpublished[0].after, Some("polkadot-stable2609-1"));
        let backports = &unpublished[0].backports;
        assert_eq!(backports.len(), 1);
        assert_eq!(backports[0].number, 13755);
        assert_eq!(backports[0].sha, "b");
        assert_eq!(backports[0].backport_of, vec![13059]);
    }

    #[test]
    fn keeps_only_published_crates_with_a_bump() {
        let crate_ = |name: &str, bump: &str| PrdocCrate {
            name: name.into(),
            bump: Some(bump.into()),
        };
        let published = HashSet::from(["frame-support", "pallet-assets"]);
        let original = [
            crate_("pallet-assets", "minor"),
            crate_("frame-support", "none"),
            // Not published (`publish = false`).
            crate_("not-a-published-crate", "patch"),
        ];
        let backport = [crate_("pallet-assets", "minor")];
        assert_eq!(
            bumped_published(&[&original, &backport], &published),
            vec!["pallet-assets"]
        );
        // No prdoc at all.
        assert!(bumped_published(&[&[]], &published).is_empty());
    }

    #[test]
    fn skips_lines_whose_releases_are_not_in_the_history() {
        let line = SdkLine {
            name: "stable2609".into(),
            has_branch: true,
            releases: vec![release("polkadot-stable2609", "elsewhere", false)],
            branch_off: None,
            history: vec![("b".into(), vec![13059, 13755])],
        };
        assert!(unpublished_backports(&[line], &BTreeMap::new()).is_empty());
    }
}
