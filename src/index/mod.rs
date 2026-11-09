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

//! The `psvm index` subcommand: precomputes the PR-independent data of the "Where is my PR?" web
//! app (`web/`) as static JSON files.
//!
//! Output files (all under `--out`):
//! - `sdk-releases.json`: polkadot-sdk release lines and their release points (tags and untagged
//!   crates.io publications), ordered oldest first.
//! - `crates/<crate>.json`: per crate, its version at every release point, the release point each
//!   version originates from, and its locked versions in every fellowship runtimes release.
//! - `crate-version-index.json`: `crate -> version -> origin release point`.
//! - `runtimes-releases.json`: fellowship runtimes releases (and `main`) with their spec versions.
//! - `crate-paths.json`: crate directory in polkadot-sdk `master` -> crate name.
//! - `live-specs.json`: runtime version currently live on each chain.
//! - `missed-prs.json`: master PRs released on an older stable line that a newer stable line has in no release.
//! - `unpublished-backports.json`: per line, the backports merged into its branch after its latest final release.
//! - `meta.json`: generation time.

mod github;
mod missed;
pub mod parse;
mod unpublished;
mod westend;

use crate::versions::{get_parity_crate_owner_crates, get_version_mapping_at_ref, MappingSource};
use futures::{stream, StreamExt, TryStreamExt};
use github::{GitHub, TagRef};
use parse::{Locked, RuntimeSpec};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

type Error = Box<dyn std::error::Error + Send + Sync>;

const SDK_REPO: &str = "paritytech/polkadot-sdk";
const RUNTIMES_REPO: &str = "polkadot-fellows/runtimes";
const CONCURRENCY: usize = 16;

/// Public JSON-RPC endpoints queried for `live-specs.json`.
const LIVE_CHAINS: &[(&str, &str)] = &[
    ("Polkadot", "https://rpc.polkadot.io"),
    (
        "Polkadot Asset Hub",
        "https://polkadot-asset-hub-rpc.polkadot.io",
    ),
    (
        "Polkadot Bridge Hub",
        "https://polkadot-bridge-hub-rpc.polkadot.io",
    ),
    (
        "Polkadot Collectives",
        "https://polkadot-collectives-rpc.polkadot.io",
    ),
    (
        "Polkadot Coretime",
        "https://polkadot-coretime-rpc.polkadot.io",
    ),
    ("Polkadot People", "https://polkadot-people-rpc.polkadot.io"),
    ("Kusama", "https://kusama-rpc.polkadot.io"),
    (
        "Kusama Asset Hub",
        "https://kusama-asset-hub-rpc.polkadot.io",
    ),
    (
        "Kusama Bridge Hub",
        "https://kusama-bridge-hub-rpc.polkadot.io",
    ),
    ("Kusama Coretime", "https://kusama-coretime-rpc.polkadot.io"),
    ("Kusama People", "https://kusama-people-rpc.polkadot.io"),
    ("Kusama Encointer", "https://kusama.api.encointer.org"),
];

/// Options of the `psvm index` subcommand.
#[derive(Debug, Clone)]
pub struct IndexOptions {
    /// Directory the JSON files are written to.
    pub out: PathBuf,
    /// Directory caching per-commit results between runs. Commits are immutable, so entries never
    /// go stale.
    pub cache_dir: Option<PathBuf>,
    /// Query public RPCs for the runtime versions currently live on chain.
    pub live: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReleaseKind {
    /// A git tag.
    Tag,
    /// A crates.io publication commit on a release branch that has no tag.
    Untagged,
}

/// A point of a release line whose crates are on crates.io (or, for rcs, about to be).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkRelease {
    /// Unique id: the tag name, or `<release>@<sha12>` for untagged publications.
    pub id: String,
    /// Human readable name: the tag name, or the release named by the publication commit.
    pub name: String,
    pub kind: ReleaseKind,
    pub sha: String,
    pub date: String,
    pub rc: bool,
    /// Other tags on the same commit, e.g. `polkadot-v1.25.0` for `polkadot-stable2609`.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub aliases: Vec<String>,
    /// First line of the crates.io publication commit, if this is one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub publication: Option<String>,
    /// File the crate versions were read from: `Plan.toml` or `Cargo.lock`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source: Option<String>,
    /// Commits on the line's branch since the previous release point; unknown for the first point, or when either
    /// point is not in the branch history.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub commits: Option<usize>,
}

/// A release line, e.g. `stable2606`, which is also the name of its branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SdkLine {
    pub name: String,
    /// Whether the line's branch exists (untagged publications are only searched there).
    #[serde(rename = "hasBranch")]
    pub has_branch: bool,
    /// Release points, oldest first.
    pub releases: Vec<SdkRelease>,
    /// Committer date of the commit where the branch left `master`, if the branch exists.
    #[serde(skip)]
    pub branch_off: Option<String>,
    /// The branch history since `branch_off`, newest first: each commit's sha and the PR numbers its title mentions.
    #[serde(skip)]
    pub history: Vec<(String, Vec<u64>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimesRelease {
    /// The tag, or `main`.
    pub name: String,
    pub sha: String,
    pub date: String,
    pub specs: Vec<RuntimeSpec>,
}

/// The polkadot-sdk release a runtimes release is built against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct SdkReleaseMatch<'a> {
    /// Id of the sdk release point.
    id: &'a str,
    /// Locked polkadot-sdk crates whose version equals the one in that release.
    matched: usize,
    /// Locked polkadot-sdk crates.
    total: usize,
}

/// A runtimes release as written to `runtimes-releases.json`.
#[derive(Debug, Serialize)]
struct RuntimesReleaseOut<'a> {
    #[serde(flatten)]
    release: &'a RuntimesRelease,
    #[serde(rename = "sdkRelease", skip_serializing_if = "Option::is_none")]
    sdk_release: Option<SdkReleaseMatch<'a>>,
}

/// An open runtimes PR that releases a new version when merged, with what its head would ship.
#[derive(Debug, Clone)]
struct PendingRelease {
    number: u64,
    title: String,
    url: String,
    draft: bool,
    created_at: String,
    head_sha: String,
    version: String,
    specs: Vec<RuntimeSpec>,
    locks: BTreeMap<String, Vec<Locked>>,
}

/// A pending release as written to `pending-releases.json`.
#[derive(Debug, Serialize)]
struct PendingReleaseOut<'a> {
    number: u64,
    title: &'a str,
    url: &'a str,
    draft: bool,
    #[serde(rename = "createdAt")]
    created_at: &'a str,
    #[serde(rename = "headSha")]
    head_sha: &'a str,
    version: &'a str,
    specs: &'a [RuntimeSpec],
    #[serde(rename = "sdkRelease", skip_serializing_if = "Option::is_none")]
    sdk_release: Option<SdkReleaseMatch<'a>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiveSpec {
    chain: String,
    rpc: String,
    #[serde(rename = "specName")]
    spec_name: String,
    #[serde(rename = "specVersion")]
    spec_version: u32,
    /// Runtimes releases shipping this exact spec.
    releases: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
struct CrateShard<'a> {
    name: &'a str,
    /// Release point id -> version of the crate at that point.
    sdk: BTreeMap<&'a str, &'a str>,
    /// Version -> the release point it originates from.
    origins: BTreeMap<&'a str, &'a str>,
    /// Runtimes release -> locked entries.
    runtimes: BTreeMap<&'a str, &'a [Locked]>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedSdkMapping {
    source: Option<String>,
    crates: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedRuntimes {
    locks: BTreeMap<String, Vec<Locked>>,
    specs: Vec<RuntimeSpec>,
}

struct Cache(Option<PathBuf>);

impl Cache {
    fn path(&self, kind: &str, key: &str) -> Option<PathBuf> {
        self.0
            .as_ref()
            .map(|dir| dir.join(kind).join(format!("{}.json", key)))
    }

    fn get<T: DeserializeOwned>(&self, kind: &str, key: &str) -> Option<T> {
        let content = std::fs::read(self.path(kind, key)?).ok()?;
        serde_json::from_slice(&content).ok()
    }

    fn put<T: Serialize>(&self, kind: &str, key: &str, value: &T) -> Result<(), Error> {
        if let Some(path) = self.path(kind, key) {
            std::fs::create_dir_all(path.parent().expect("joined path has a parent"))?;
            std::fs::write(path, serde_json::to_vec(value)?)?;
        }
        Ok(())
    }
}

/// Runs the indexer. Needs a `GITHUB_TOKEN` (GraphQL is not available unauthenticated).
pub async fn run(options: IndexOptions) -> Result<(), Error> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "`psvm index` needs GITHUB_TOKEN, e.g. `GITHUB_TOKEN=$(gh auth token)`")?;
    let gh = GitHub::new(token);
    let cache = Cache(options.cache_dir.clone());

    let mut lines = sdk_lines(&gh).await?;
    let mappings = sdk_mappings(&cache, &mut lines).await?;
    let runtimes = runtimes_releases(&gh, &cache).await?;

    let crates: HashSet<&str> = mappings
        .values()
        .flat_map(|crates| crates.keys().map(String::as_str))
        .collect();
    log::info!("indexed {} crates", crates.len());

    let crate_paths = crate_paths(&gh, &cache, &crates).await?;
    let pending = pending_releases(&gh, &cache).await?;
    let mut numbers = missed::mentioned_numbers(&lines);
    numbers.extend(unpublished::unpublished_numbers(&lines));
    let mentioned = missed::mentioned_prs(&gh, &cache, &numbers).await?;
    let missed = missed::missed_prs(&lines, &mentioned);
    let westend = if options.live {
        let subscan_key = std::env::var("SUBSCAN_API_KEY")
            .ok()
            .filter(|k| !k.is_empty());
        westend::westend(&gh, &cache, subscan_key.as_deref()).await
    } else {
        vec![]
    };
    let mut unpublished = unpublished::unpublished_backports(&lines, &mentioned);
    unpublished::add_crates(&gh, &cache, &mut unpublished, &crates).await?;
    let live = if options.live {
        live_specs(&gh, &runtimes).await
    } else {
        vec![]
    };

    write_output(
        &options.out,
        &lines,
        &mappings,
        &runtimes,
        &crate_paths,
        &live,
        &pending,
        &missed,
        &westend,
        &unpublished,
    )
}

/// Lists all release lines with their tags and untagged crates.io publications.
async fn sdk_lines(gh: &GitHub) -> Result<Vec<SdkLine>, Error> {
    let tags = gh.tags("paritytech", "polkadot-sdk").await?;
    log::info!("polkadot-sdk has {} tags", tags.len());

    let mut aliases: HashMap<&str, Vec<String>> = HashMap::new();
    for tag in tags.iter().filter(|t| parse::is_alias_tag(&t.name)) {
        aliases.entry(&tag.sha).or_default().push(tag.name.clone());
    }

    let mut by_line: BTreeMap<String, Vec<SdkRelease>> = BTreeMap::new();
    for tag in &tags {
        let Some(class) = parse::classify_sdk_tag(&tag.name) else {
            continue;
        };
        by_line.entry(class.line).or_default().push(SdkRelease {
            id: tag.name.clone(),
            name: tag.name.clone(),
            kind: ReleaseKind::Tag,
            sha: tag.sha.clone(),
            date: tag.date.clone(),
            rc: class.rc.is_some(),
            aliases: aliases.get(tag.sha.as_str()).cloned().unwrap_or_default(),
            publication: None,
            source: None,
            commits: None,
        });
    }

    let lines = stream::iter(by_line)
        .map(|(name, releases)| line_with_publications(gh, name, releases))
        .buffer_unordered(CONCURRENCY)
        .try_collect::<Vec<_>>()
        .await?;
    Ok(lines)
}

/// Adds the crates.io publication commits of the line's branch to its tagged releases.
async fn line_with_publications(
    gh: &GitHub,
    name: String,
    mut releases: Vec<SdkRelease>,
) -> Result<SdkLine, Error> {
    // Publications happen after the first rc is cut; backports can land from the branch-off on.
    let compare = format!(
        "/repos/{}/compare/master...{}?per_page=1&page=2",
        SDK_REPO, name
    );
    let branch_off = gh.rest(&compare).await?.and_then(|c| {
        c["merge_base_commit"]["commit"]["committer"]["date"]
            .as_str()
            .map(String::from)
    });
    let first_release = releases
        .iter()
        .map(|r| r.date.as_str())
        .min()
        .unwrap_or_default();
    let since = branch_off
        .as_deref()
        .map_or(first_release, |b| b.min(first_release))
        .to_string();
    let commits = gh.commits_since(SDK_REPO, &name, &since).await?;
    let has_branch = commits.is_some();
    let history: Vec<String> = commits.iter().flatten().map(|c| c.sha.clone()).collect();
    let mentions: Vec<(String, Vec<u64>)> = commits
        .iter()
        .flatten()
        .map(|c| {
            let title = c.message.lines().next().unwrap_or_default();
            (c.sha.clone(), parse::pr_mentions(title))
        })
        .collect();

    for commit in commits.into_iter().flatten() {
        let first_line = commit.message.lines().next().unwrap_or_default();
        let Some(release_name) = parse::parse_publication_message(first_line) else {
            continue;
        };
        if let Some(tagged) = releases.iter_mut().find(|r| r.sha == commit.sha) {
            tagged.publication = Some(first_line.to_string());
            continue;
        }
        let release_name = release_name.unwrap_or_else(|| "untagged".into());
        releases.push(SdkRelease {
            id: format!("{}@{}", release_name, &commit.sha[..12]),
            name: release_name,
            kind: ReleaseKind::Untagged,
            sha: commit.sha,
            date: commit.date,
            rc: false,
            aliases: vec![],
            publication: Some(first_line.to_string()),
            source: None,
            commits: None,
        });
    }

    releases.sort_by_key(release_order_key);
    count_commits_between(&mut releases, &history);
    log::info!("line {}: {} release points", name, releases.len());
    Ok(SdkLine {
        name,
        has_branch,
        releases,
        branch_off,
        history: mentions,
    })
}

/// Releases of a line are ordered by commit date; ties (several tags on one commit) by patch,
/// with rcs before the final release.
/// Sets `commits` of each release point to the commits since the previous one, from their positions in the branch
/// history (newest first, as the commits API lists it).
fn count_commits_between(releases: &mut [SdkRelease], history: &[String]) {
    let position = |sha: &str| history.iter().position(|h| h == sha);
    for i in 1..releases.len() {
        let (prev, cur) = (position(&releases[i - 1].sha), position(&releases[i].sha));
        releases[i].commits = match (prev, cur) {
            (Some(prev), Some(cur)) if prev >= cur => Some(prev - cur),
            _ => None,
        };
    }
}

fn release_order_key(release: &SdkRelease) -> (String, u32, bool, Option<u32>) {
    let class = parse::classify_sdk_tag(&release.name);
    (
        release.date.clone(),
        class.as_ref().map_or(u32::MAX, |c| c.patch),
        class.as_ref().is_none_or(|c| c.rc.is_none()),
        class.and_then(|c| c.rc),
    )
}

/// Reads the `crate -> version` map of every release point (sha -> map).
async fn sdk_mappings(
    cache: &Cache,
    lines: &mut [SdkLine],
) -> Result<HashMap<String, BTreeMap<String, String>>, Error> {
    let shas: HashSet<String> = lines
        .iter()
        .flat_map(|l| l.releases.iter().map(|r| r.sha.clone()))
        .collect();

    let mut cached: HashMap<String, CachedSdkMapping> = HashMap::new();
    let mut missing = vec![];
    for sha in shas {
        match cache.get::<CachedSdkMapping>("sdk", &sha) {
            Some(mapping) => {
                cached.insert(sha, mapping);
            }
            None => missing.push(sha),
        }
    }
    log::info!(
        "crate maps: {} cached, {} to fetch",
        cached.len(),
        missing.len()
    );

    if !missing.is_empty() {
        let owners = get_parity_crate_owner_crates()
            .await
            .map_err(|e| e.to_string())?;
        let owners = &owners;
        let fetched: Vec<(String, CachedSdkMapping)> = stream::iter(missing)
            .map(|sha| async move {
                let mapping = get_version_mapping_at_ref(crate::DEFAULT_GIT_SERVER, &sha, owners)
                    .await
                    .map_err(|e| format!("crate map at {}: {}", sha, e))?;
                let mapping = match mapping {
                    Some((crates, source)) => CachedSdkMapping {
                        source: Some(source.as_str().to_string()),
                        crates,
                    },
                    None => CachedSdkMapping {
                        source: None,
                        crates: BTreeMap::new(),
                    },
                };
                Ok::<_, Error>((sha, mapping))
            })
            .buffer_unordered(CONCURRENCY)
            .try_collect()
            .await?;
        for (sha, mapping) in fetched {
            cache.put("sdk", &sha, &mapping)?;
            cached.insert(sha, mapping);
        }
    }

    for release in lines.iter_mut().flat_map(|l| l.releases.iter_mut()) {
        release.source = cached[&release.sha].source.clone();
    }
    Ok(cached
        .into_iter()
        .map(|(sha, mapping)| (sha, mapping.crates))
        .collect())
}

/// Lists fellowship runtimes releases, newest first, `main` on top.
async fn runtimes_releases(
    gh: &GitHub,
    cache: &Cache,
) -> Result<Vec<(RuntimesRelease, BTreeMap<String, Vec<Locked>>)>, Error> {
    let mut refs: Vec<TagRef> = gh
        .tags("polkadot-fellows", "runtimes")
        .await?
        .into_iter()
        .filter(|t| parse::is_runtimes_release_tag(&t.name))
        .collect();
    refs.sort_by_key(|t| std::cmp::Reverse(semver_key(&t.name)));
    let main = gh.branch_head(RUNTIMES_REPO, "main").await?;
    refs.insert(
        0,
        TagRef {
            name: "main".into(),
            sha: main.sha,
            date: main.date,
        },
    );

    stream::iter(refs)
        .map(|r| async move {
            let data = match cache.get::<CachedRuntimes>("runtimes", &r.sha) {
                Some(data) => data,
                None => {
                    let data = fetch_runtimes_release(gh, &r.sha).await?;
                    cache.put("runtimes", &r.sha, &data)?;
                    data
                }
            };
            let release = RuntimesRelease {
                name: r.name,
                sha: r.sha,
                date: r.date,
                specs: data.specs,
            };
            Ok::<_, Error>((release, data.locks))
        })
        .buffered(4)
        .try_collect()
        .await
}

fn semver_key(tag: &str) -> Vec<u32> {
    tag.trim_start_matches('v')
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

async fn fetch_runtimes_release(gh: &GitHub, sha: &str) -> Result<CachedRuntimes, Error> {
    let lock = gh
        .raw(RUNTIMES_REPO, sha, "Cargo.lock")
        .await?
        .unwrap_or_default();
    let locks = parse::parse_runtime_lock(&lock);

    let candidates: Vec<String> = gh
        .tree_paths(RUNTIMES_REPO, sha)
        .await?
        .into_iter()
        .filter(|p| parse::is_runtime_lib_candidate(p))
        .collect();
    let mut specs: Vec<RuntimeSpec> = stream::iter(candidates)
        .map(|path| async move {
            let content = gh.raw(RUNTIMES_REPO, sha, &path).await?;
            Ok::<_, Error>(content.and_then(|c| parse::parse_runtime_spec(&path, &c)))
        })
        .buffer_unordered(CONCURRENCY)
        .try_filter_map(|spec| async move { Ok(spec) })
        .try_collect()
        .await?;
    specs.sort_by(|a, b| a.path.cmp(&b.path));
    log::info!("runtimes {}: {} specs", &sha[..12], specs.len());
    Ok(CachedRuntimes { locks, specs })
}

/// Open runtimes PRs among the newest `PENDING_PRS` that release a version when merged (see
/// `parse::parse_release_changelog_patch`), with the `Cargo.lock` and spec versions of their head.
async fn pending_releases(gh: &GitHub, cache: &Cache) -> Result<Vec<PendingRelease>, Error> {
    const PENDING_PRS: usize = 10;
    let path = format!(
        "/repos/{}/pulls?state=open&sort=created&direction=desc&per_page={}",
        RUNTIMES_REPO, PENDING_PRS
    );
    let prs = gh
        .rest(&path)
        .await?
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    let mut pending = vec![];
    for pr in prs {
        let number = pr["number"].as_u64().unwrap_or_default();
        let files_path = format!(
            "/repos/{}/pulls/{}/files?per_page=100",
            RUNTIMES_REPO, number
        );
        let files = gh
            .rest(&files_path)
            .await?
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        let Some(version) = files
            .iter()
            .filter(|f| f["filename"] == "CHANGELOG.md")
            .find_map(|f| parse::parse_release_changelog_patch(f["patch"].as_str()?))
        else {
            continue;
        };
        let head_sha = pr["head"]["sha"].as_str().unwrap_or_default().to_string();
        let data = match cache.get::<CachedRuntimes>("runtimes", &head_sha) {
            Some(data) => data,
            None => {
                let data = fetch_runtimes_release(gh, &head_sha).await?;
                cache.put("runtimes", &head_sha, &data)?;
                data
            }
        };
        log::info!("pending runtimes release {} in #{}", version, number);
        let text = |key: &str| pr[key].as_str().unwrap_or_default().to_string();
        pending.push(PendingRelease {
            number,
            title: text("title"),
            url: text("html_url"),
            draft: pr["draft"].as_bool().unwrap_or_default(),
            created_at: text("created_at"),
            head_sha,
            version,
            specs: data.specs,
            locks: data.locks,
        });
    }
    Ok(pending)
}

/// Maps crate directories of polkadot-sdk `master` to crate names, for the crates in `crates`.
async fn crate_paths(
    gh: &GitHub,
    cache: &Cache,
    crates: &HashSet<&str>,
) -> Result<BTreeMap<String, String>, Error> {
    let master = gh.branch_head(SDK_REPO, "master").await?;
    let all: BTreeMap<String, String> = match cache.get("crate-paths", &master.sha) {
        Some(paths) => paths,
        None => {
            let root = gh
                .raw(SDK_REPO, &master.sha, "Cargo.toml")
                .await?
                .ok_or("polkadot-sdk has no root Cargo.toml")?;
            let members = parse::parse_workspace_members(&root)?;
            let sha = master.sha.as_str();
            let paths: BTreeMap<String, String> = stream::iter(members)
                .map(|member| async move {
                    let manifest = gh
                        .raw(SDK_REPO, sha, &format!("{}/Cargo.toml", member))
                        .await?;
                    Ok::<_, Error>(
                        manifest
                            .and_then(|m| parse::parse_package_name(&m))
                            .map(|name| (member, name)),
                    )
                })
                .buffer_unordered(CONCURRENCY)
                .try_filter_map(|entry| async move { Ok(entry) })
                .try_collect()
                .await?;
            cache.put("crate-paths", &master.sha, &paths)?;
            paths
        }
    };
    Ok(all
        .into_iter()
        .filter(|(_, name)| crates.contains(name.as_str()))
        .collect())
}

async fn live_specs(
    gh: &GitHub,
    runtimes: &[(RuntimesRelease, BTreeMap<String, Vec<Locked>>)],
) -> Vec<LiveSpec> {
    stream::iter(LIVE_CHAINS)
        .map(|(chain, rpc)| async move {
            match gh.runtime_version(rpc).await {
                Ok((spec_name, spec_version)) => {
                    let releases = runtimes
                        .iter()
                        .filter(|(r, _)| {
                            r.specs
                                .iter()
                                .any(|s| s.spec_name == spec_name && s.spec_version == spec_version)
                        })
                        .map(|(r, _)| r.name.clone())
                        .collect();
                    Some(LiveSpec {
                        chain: chain.to_string(),
                        rpc: rpc.to_string(),
                        spec_name,
                        spec_version,
                        releases,
                    })
                }
                Err(e) => {
                    log::warn!("live spec of {} ({}) unavailable: {:?}", chain, rpc, e);
                    None
                }
            }
        })
        .buffered(CONCURRENCY)
        .filter_map(|spec| async move { spec })
        .collect()
        .await
}

/// Picks the release point a crate version originates from: the earliest final release whose
/// versions come from `Plan.toml`, then from `Cargo.lock`, then the earliest rc. rc tags have no
/// `Plan.toml`; their `Cargo.lock` lists workspace versions that may not be published yet.
fn origin_rank(release: &SdkRelease) -> (bool, bool, &str) {
    (
        release.rc,
        release.source.as_deref() != Some(MappingSource::PlanToml.as_str()),
        release.date.as_str(),
    )
}

/// The final (non-rc) sdk release point whose crate versions match the most crates.io crates
/// locked by a runtimes release; ties go to the newest. rcs are skipped: their `Cargo.lock`
/// versions may never have been published.
fn matching_sdk_release<'a>(
    locks: &BTreeMap<String, Vec<Locked>>,
    lines: &'a [SdkLine],
    mappings: &HashMap<String, BTreeMap<String, String>>,
    sdk_crates: &HashSet<&str>,
) -> Option<SdkReleaseMatch<'a>> {
    let locked: Vec<(&str, &str)> = locks
        .iter()
        .filter(|(name, _)| sdk_crates.contains(name.as_str()))
        .flat_map(|(name, entries)| {
            entries.iter().filter_map(move |entry| match entry {
                Locked::Registry { v, .. } => Some((name.as_str(), v.as_str())),
                Locked::Git(_) => None,
            })
        })
        .collect();
    let total = locks
        .keys()
        .filter(|name| sdk_crates.contains(name.as_str()))
        .count();
    lines
        .iter()
        .flat_map(|l| l.releases.iter())
        .filter(|r| !r.rc && r.source.is_some())
        .map(|release| {
            let mapping = &mappings[&release.sha];
            let matched = locked
                .iter()
                .filter(|(name, v)| mapping.get(*name).map(String::as_str) == Some(*v))
                .count();
            (matched, release.date.as_str(), release)
        })
        .filter(|(matched, _, _)| *matched > 0)
        .max_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)))
        .map(|(matched, _, release)| SdkReleaseMatch {
            id: &release.id,
            matched,
            total,
        })
}

#[allow(clippy::too_many_arguments)]
fn write_output(
    out: &Path,
    lines: &[SdkLine],
    mappings: &HashMap<String, BTreeMap<String, String>>,
    runtimes: &[(RuntimesRelease, BTreeMap<String, Vec<Locked>>)],
    crate_paths: &BTreeMap<String, String>,
    live: &[LiveSpec],
    pending: &[PendingRelease],
    missed: &[missed::MissedPr],
    westend: &[westend::WestendRuntime],
    unpublished: &[unpublished::UnpublishedLine],
) -> Result<(), Error> {
    let mut shards: BTreeMap<&str, CrateShard> = BTreeMap::new();
    let mut origin_ranks: HashMap<(&str, &str), (bool, bool, &str)> = HashMap::new();
    for release in lines.iter().flat_map(|l| l.releases.iter()) {
        for (name, version) in &mappings[&release.sha] {
            let shard = shards.entry(name).or_insert_with(|| CrateShard {
                name,
                ..Default::default()
            });
            shard.sdk.insert(&release.id, version);
            let rank = origin_rank(release);
            let best = origin_ranks.entry((name, version)).or_insert(rank);
            if rank <= *best {
                *best = rank;
                shard.origins.insert(version, &release.id);
            }
        }
    }
    for (release, locks) in runtimes {
        for (name, locked) in locks {
            if let Some(shard) = shards.get_mut(name.as_str()) {
                shard.runtimes.insert(&release.name, locked);
            }
        }
    }

    let mut ordered_lines = lines.to_vec();
    // Most recently released line first.
    ordered_lines.sort_by(|a, b| {
        let last = |l: &SdkLine| l.releases.last().map(|r| r.date.clone());
        last(b).cmp(&last(a))
    });

    let crates_dir = out.join("crates");
    if crates_dir.exists() {
        std::fs::remove_dir_all(&crates_dir)?;
    }
    std::fs::create_dir_all(&crates_dir)?;
    for (name, shard) in &shards {
        // Names come from remote Plan.toml/Cargo.lock files and become file names: never let one escape `crates/`.
        if !parse::is_valid_crate_name(name) {
            log::warn!("skipping crate with invalid name {name:?}");
            continue;
        }
        std::fs::write(
            crates_dir.join(format!("{}.json", name)),
            serde_json::to_vec(shard)?,
        )?;
    }

    let index: BTreeMap<&str, &BTreeMap<&str, &str>> =
        shards.iter().map(|(n, s)| (*n, &s.origins)).collect();
    let sdk_crates: HashSet<&str> = shards.keys().copied().collect();
    let runtimes_meta: Vec<RuntimesReleaseOut> = runtimes
        .iter()
        .map(|(release, locks)| RuntimesReleaseOut {
            release,
            sdk_release: matching_sdk_release(locks, lines, mappings, &sdk_crates),
        })
        .collect();
    let pending_out: Vec<PendingReleaseOut> = pending
        .iter()
        .map(|p| PendingReleaseOut {
            number: p.number,
            title: &p.title,
            url: &p.url,
            draft: p.draft,
            created_at: &p.created_at,
            head_sha: &p.head_sha,
            version: &p.version,
            specs: &p.specs,
            sdk_release: matching_sdk_release(&p.locks, lines, mappings, &sdk_crates),
        })
        .collect();
    let generated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();

    let write = |file: &str, value: serde_json::Value| -> Result<(), Error> {
        std::fs::write(out.join(file), serde_json::to_vec(&value)?)?;
        Ok(())
    };
    write(
        "sdk-releases.json",
        serde_json::json!({ "lines": ordered_lines }),
    )?;
    write("crate-version-index.json", serde_json::to_value(&index)?)?;
    write(
        "runtimes-releases.json",
        serde_json::to_value(&runtimes_meta)?,
    )?;
    write("crate-paths.json", serde_json::to_value(crate_paths)?)?;
    write("live-specs.json", serde_json::to_value(live)?)?;
    write("pending-releases.json", serde_json::to_value(&pending_out)?)?;
    write("missed-prs.json", serde_json::to_value(missed)?)?;
    write("westend.json", serde_json::to_value(westend)?)?;
    write(
        "unpublished-backports.json",
        serde_json::to_value(unpublished)?,
    )?;
    write(
        "meta.json",
        serde_json::json!({
            "generatedAt": generated_at,
            "psvmVersion": env!("CARGO_PKG_VERSION"),
            "crates": shards.len(),
            "sdkReleasePoints": lines.iter().map(|l| l.releases.len()).sum::<usize>(),
            "runtimesReleases": runtimes.len(),
        }),
    )?;
    log::info!(
        "wrote {} crate shards and indexes to {}",
        shards.len(),
        out.display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(name: &str, date: &str, source: Option<&str>) -> SdkRelease {
        SdkRelease {
            id: name.into(),
            name: name.into(),
            kind: ReleaseKind::Tag,
            sha: name.into(),
            date: date.into(),
            rc: parse::classify_sdk_tag(name).is_some_and(|c| c.rc.is_some()),
            aliases: vec![],
            publication: None,
            source: source.map(String::from),
            commits: None,
        }
    }

    #[test]
    fn counts_commits_between_release_points() {
        let mut releases = [
            release("a", "", None),
            release("b", "", None),
            release("c", "", None),
            release("d", "", None),
        ];
        releases[2].sha = "b".into(); // Same commit as the previous point.
        releases[3].sha = "x".into(); // Not in the history.
        let history: Vec<String> = ["b", "y", "z", "a"].map(String::from).to_vec();
        count_commits_between(&mut releases, &history);
        let counts: Vec<_> = releases.iter().map(|r| r.commits).collect();
        assert_eq!(counts, vec![None, Some(3), Some(0), None]);
    }

    #[test]
    fn orders_releases_of_a_line() {
        let mut releases = [
            release("polkadot-stable2606-1", "2026-08-06T13:09:57Z", None),
            release("polkadot-stable2606", "2026-07-03T08:57:30Z", None),
            release("polkadot-stable2606-rc2", "2026-06-10T00:00:00Z", None),
            // A final tag put on the same commit as its last rc sorts after it.
            release("polkadot-stable2606-1-rc1", "2026-08-06T13:09:57Z", None),
            release("polkadot-stable2606-rc1", "2026-06-02T00:00:00Z", None),
        ];
        releases.sort_by_key(release_order_key);
        let names: Vec<_> = releases.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "polkadot-stable2606-rc1",
                "polkadot-stable2606-rc2",
                "polkadot-stable2606",
                "polkadot-stable2606-1-rc1",
                "polkadot-stable2606-1",
            ]
        );
    }

    #[test]
    fn origin_prefers_final_plan_toml_releases() {
        let rc = release(
            "polkadot-stable2609-rc1",
            "2026-08-01T00:00:00Z",
            Some("Cargo.lock"),
        );
        let final_lock = release(
            "polkadot-stable2609",
            "2026-09-30T00:00:00Z",
            Some("Cargo.lock"),
        );
        let final_plan = release(
            "polkadot-stable2609-1",
            "2026-10-30T00:00:00Z",
            Some("Plan.toml"),
        );
        let older_plan = release(
            "polkadot-stable2606",
            "2026-07-03T00:00:00Z",
            Some("Plan.toml"),
        );
        assert!(origin_rank(&final_plan) < origin_rank(&final_lock));
        assert!(origin_rank(&final_lock) < origin_rank(&rc));
        assert!(origin_rank(&older_plan) < origin_rank(&final_plan));
    }

    #[test]
    fn writes_shards_with_origins_and_runtime_locks() {
        let out = std::env::temp_dir().join(format!("psvm-index-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();

        let mut tagged = release(
            "polkadot-stable2606-3",
            "2026-10-08T12:09:10Z",
            Some("Plan.toml"),
        );
        tagged.sha = "a".repeat(40);
        let untagged = SdkRelease {
            id: "stable2606-4@83593cc54687".into(),
            name: "stable2606-4".into(),
            kind: ReleaseKind::Untagged,
            sha: "b".repeat(40),
            date: "2026-10-22T14:13:29Z".into(),
            rc: false,
            aliases: vec![],
            publication: Some(
                "[stable2606] Post crates release activities for stable2606-4".into(),
            ),
            source: Some("Plan.toml".into()),
            commits: None,
        };
        let lines = vec![SdkLine {
            name: "stable2606".into(),
            has_branch: true,
            releases: vec![tagged, untagged],
            branch_off: None,
            history: vec![],
        }];
        let mappings = HashMap::from([
            (
                "a".repeat(40),
                BTreeMap::from([("staging-xcm-executor".to_string(), "28.0.1".to_string())]),
            ),
            (
                "b".repeat(40),
                BTreeMap::from([("staging-xcm-executor".to_string(), "28.1.0".to_string())]),
            ),
        ]);
        let runtimes = vec![(
            RuntimesRelease {
                name: "v2.5.1".into(),
                sha: "c".repeat(40),
                date: "2026-10-23T00:00:00Z".into(),
                specs: vec![],
            },
            BTreeMap::from([
                (
                    "staging-xcm-executor".to_string(),
                    vec![Locked::Registry {
                        v: "28.1.0".into(),
                        line: 42,
                    }],
                ),
                ("serde".to_string(), vec![Locked::Git("git:abc".into())]),
            ]),
        )];

        write_output(
            &out,
            &lines,
            &mappings,
            &runtimes,
            &BTreeMap::new(),
            &[],
            &[],
            &[],
            &[],
            &[],
        )
        .unwrap();

        let shard: serde_json::Value = serde_json::from_slice(
            &std::fs::read(out.join("crates/staging-xcm-executor.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(shard["origins"]["28.1.0"], "stable2606-4@83593cc54687");
        assert_eq!(shard["origins"]["28.0.1"], "polkadot-stable2606-3");
        assert_eq!(shard["runtimes"]["v2.5.1"][0]["v"], "28.1.0");
        assert_eq!(shard["runtimes"]["v2.5.1"][0]["line"], 42);
        let runtimes_out: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("runtimes-releases.json")).unwrap())
                .unwrap();
        assert_eq!(
            runtimes_out[0]["sdkRelease"],
            serde_json::json!({ "id": "stable2606-4@83593cc54687", "matched": 1, "total": 1 })
        );
        // Crates that are not polkadot-sdk crates get no shard.
        assert!(!out.join("crates/serde.json").exists());

        let releases: serde_json::Value =
            serde_json::from_slice(&std::fs::read(out.join("sdk-releases.json")).unwrap()).unwrap();
        assert_eq!(releases["lines"][0]["releases"][1]["kind"], "untagged");
        std::fs::remove_dir_all(&out).unwrap();
    }
}
