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

//! Pure parsing helpers of the indexer. Nothing in here touches the network.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// A polkadot-sdk release tag that belongs to a stable or unstable release line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SdkTag {
    /// The release line, which is also the name of its branch, e.g. `stable2606`.
    pub line: String,
    /// Patch number, `0` for the initial release of a line.
    pub patch: u32,
    /// Release candidate number, if this is an rc tag.
    pub rc: Option<u32>,
}

fn sdk_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^polkadot-((?:stable|unstable)\d{4})(?:-(\d+))?(?:-rc(\d+))?$").unwrap()
    })
}

/// Classifies a polkadot-sdk tag name, e.g. `polkadot-stable2606-1-rc2`.
///
/// Returns `None` for tags that are not part of a stable/unstable line (weekly tags, legacy
/// `polkadot-vX.Y.Z` tags, experiments such as `polkadot-unstable2507-revive`).
pub fn classify_sdk_tag(name: &str) -> Option<SdkTag> {
    let caps = sdk_tag_regex().captures(name)?;
    Some(SdkTag {
        line: caps[1].to_string(),
        patch: caps.get(2).map_or(0, |m| m.as_str().parse().unwrap_or(0)),
        rc: caps.get(3).map(|m| m.as_str().parse().unwrap_or(0)),
    })
}

/// Whether `name` is a legacy `polkadot-vX.Y.Z` tag. These are put on the same commit as a stable
/// tag, so they are recorded as aliases of it.
pub fn is_alias_tag(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^polkadot-v\d+\.\d+\.\d+$").unwrap())
        .is_match(name)
}

/// Whether `name` is a `polkadot-fellows/runtimes` release tag, e.g. `v2.5.1`.
pub fn is_runtimes_release_tag(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^v\d+\.\d+\.\d+$").unwrap())
        .is_match(name)
}

/// Parses the first line of a release-branch commit message that marks a crates.io publication,
/// e.g. `[stable2606] Post crates release activities for stable2606-4 (#13556)`.
///
/// Returns `Some(Some(release))` if the release is named, `Some(None)` if the commit is a
/// publication but does not name the release, and `None` if it is not a publication commit.
pub fn parse_publication_message(first_line: &str) -> Option<Option<String>> {
    static RE: OnceLock<Regex> = OnceLock::new();
    static NAME: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\bpost[- ]crates?[- ](release|publis)|\bapply version bumps for\b")
            .unwrap()
    });
    if !re.is_match(first_line) {
        return None;
    }
    let name = NAME.get_or_init(|| Regex::new(r"\b((?:stable|unstable)\d{4}(?:-\d+)?)\b").unwrap());
    // The release name is the last `stableYYMM[-N]` mentioned, ignoring the `[stableYYMM]` prefix.
    let without_prefix = first_line
        .trim_start()
        .strip_prefix('[')
        .and_then(|rest| rest.split_once(']').map(|(_, tail)| tail))
        .unwrap_or(first_line);
    Some(
        name.captures_iter(without_prefix)
            .last()
            .map(|caps| caps[1].to_string()),
    )
}

/// One locked package of a runtimes `Cargo.lock`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Locked {
    /// A crates.io package: its version and the (1-based) line of its `name = ...` entry.
    Registry { v: String, line: usize },
    /// A git dependency, recorded as `git:<rev>`; its version cannot be tied to a release.
    Git(String),
}

/// Parses a `Cargo.lock` of a runtimes repository into `crate -> [locked entries]`.
///
/// Workspace-local packages (no `source`) are skipped. A crate can be locked at several versions.
pub fn parse_runtime_lock(content: &str) -> BTreeMap<String, Vec<Locked>> {
    #[derive(Default)]
    struct Pending {
        name: Option<(String, usize)>,
        version: Option<String>,
        source: Option<String>,
    }

    fn flush(pending: Pending, out: &mut BTreeMap<String, Vec<Locked>>) {
        let (Some((name, line)), Some(version), Some(source)) =
            (pending.name, pending.version, pending.source)
        else {
            return;
        };
        let locked = if source.starts_with("registry+") || source.starts_with("sparse+") {
            Locked::Registry { v: version, line }
        } else if let Some(git) = source.strip_prefix("git+") {
            let rev = git.rsplit_once('#').map_or(git, |(_, rev)| rev);
            Locked::Git(format!("git:{}", rev))
        } else {
            return;
        };
        out.entry(name).or_default().push(locked);
    }

    fn string_value(line: &str, key: &str) -> Option<String> {
        let rest = line
            .strip_prefix(key)?
            .trim_start()
            .strip_prefix('=')?
            .trim();
        Some(rest.trim_matches('"').to_string())
    }

    let mut out = BTreeMap::new();
    let mut pending: Option<Pending> = None;
    for (idx, line) in content.lines().enumerate() {
        let line = line.trim();
        if line == "[[package]]" {
            if let Some(p) = pending.take() {
                flush(p, &mut out);
            }
            pending = Some(Pending::default());
            continue;
        }
        if line.starts_with('[') {
            if let Some(p) = pending.take() {
                flush(p, &mut out);
            }
            continue;
        }
        let Some(p) = pending.as_mut() else { continue };
        if let Some(name) = string_value(line, "name") {
            p.name = Some((name, idx + 1));
        } else if let Some(version) = string_value(line, "version") {
            p.version = Some(version);
        } else if let Some(source) = string_value(line, "source") {
            p.source = Some(source);
        }
    }
    if let Some(p) = pending.take() {
        flush(p, &mut out);
    }
    out
}

/// `spec_name` and `spec_version` of a runtime, read from its `lib.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeSpec {
    /// Path of the `lib.rs` in the runtimes repository.
    pub path: String,
    #[serde(rename = "specName")]
    pub spec_name: String,
    #[serde(rename = "specVersion")]
    pub spec_version: u32,
}

/// Extracts the first `spec_name` / `spec_version` pair of a runtime `lib.rs`.
pub fn parse_runtime_spec(path: &str, content: &str) -> Option<RuntimeSpec> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    static VERSION: OnceLock<Regex> = OnceLock::new();
    let name = NAME.get_or_init(|| Regex::new(r#"spec_name:\s*[^"\n]*"([^"]+)""#).unwrap());
    let version = VERSION.get_or_init(|| Regex::new(r"spec_version:\s*([0-9_]+)").unwrap());
    Some(RuntimeSpec {
        path: path.to_string(),
        spec_name: name.captures(content)?[1].to_string(),
        spec_version: version.captures(content)?[1]
            .replace('_', "")
            .parse()
            .ok()?,
    })
}

/// Whether a path of the runtimes repository may be a runtime's `lib.rs` (as opposed to the
/// `lib.rs` of a helper crate such as `constants` or `primitives`).
pub fn is_runtime_lib_candidate(path: &str) -> bool {
    const HELPERS: &[&str] = &[
        "constants",
        "primitives",
        "common",
        "test-utils",
        "pallets",
        "integration-tests",
        "helpers",
        "chain-spec-generator",
    ];
    let Some(dir) = path.strip_suffix("/src/lib.rs") else {
        return false;
    };
    (dir.starts_with("relay/") || dir.starts_with("system-parachains/"))
        && !dir.split('/').any(|segment| HELPERS.contains(&segment))
}

/// Reads `workspace.members` of a `Cargo.toml`.
pub fn parse_workspace_members(content: &str) -> Result<Vec<String>, toml::de::Error> {
    #[derive(Deserialize)]
    struct Root {
        workspace: Workspace,
    }
    #[derive(Deserialize)]
    struct Workspace {
        #[serde(default)]
        members: Vec<String>,
    }
    Ok(toml::from_str::<Root>(content)?.workspace.members)
}

/// Reads `package.name` of a `Cargo.toml`.
pub fn parse_package_name(content: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Root {
        package: Option<Package>,
    }
    #[derive(Deserialize)]
    struct Package {
        name: String,
    }
    toml::from_str::<Root>(content)
        .ok()?
        .package
        .map(|p| p.name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_sdk_tags() {
        let tag = |line: &str, patch, rc| {
            Some(SdkTag {
                line: line.into(),
                patch,
                rc,
            })
        };
        assert_eq!(
            classify_sdk_tag("polkadot-stable2606"),
            tag("stable2606", 0, None)
        );
        assert_eq!(
            classify_sdk_tag("polkadot-stable2606-3"),
            tag("stable2606", 3, None)
        );
        assert_eq!(
            classify_sdk_tag("polkadot-stable2606-rc4"),
            tag("stable2606", 0, Some(4))
        );
        assert_eq!(
            classify_sdk_tag("polkadot-stable2606-1-rc1"),
            tag("stable2606", 1, Some(1))
        );
        assert_eq!(
            classify_sdk_tag("polkadot-unstable2604-rc5"),
            tag("unstable2604", 0, Some(5))
        );
        assert_eq!(
            classify_sdk_tag("polkadot-stable6210-rc1"),
            tag("stable6210", 0, Some(1))
        );
        for ignored in [
            "polkadot-unstable2507-revive",
            "polkadot-weekly2026w20-rc1",
            "polkadot-v1.25.0",
            "polkadot-stable2412-2-with-backport-1",
            "v1.13.0-rc1",
        ] {
            assert_eq!(classify_sdk_tag(ignored), None, "{ignored}");
        }
    }

    #[test]
    fn detects_alias_and_runtimes_tags() {
        assert!(is_alias_tag("polkadot-v1.25.0"));
        assert!(!is_alias_tag("polkadot-v1.25.0-nix"));
        assert!(is_runtimes_release_tag("v2.5.1"));
        assert!(!is_runtimes_release_tag("v1.1.1-rc1"));
    }

    #[test]
    fn parses_publication_messages() {
        let named = |s: &str| Some(Some(s.to_string()));
        assert_eq!(
            parse_publication_message(
                "[stable2606] Post crates release activities for stable2606-4 (#13556)"
            ),
            named("stable2606-4")
        );
        assert_eq!(
            parse_publication_message("[stable2606] Post crates release stable2606-3 (#13449)"),
            named("stable2606-3")
        );
        assert_eq!(
            parse_publication_message(
                "[stable2606] Post crates publis pallet-revive-eth-rpc (#13451)"
            ),
            Some(None)
        );
        assert_eq!(
            parse_publication_message("[stable2603] Post crates release activities (#11768)"),
            Some(None)
        );
        assert_eq!(
            parse_publication_message("[stable2606] Bump spec_version to 1_024_001 (#12495)"),
            None
        );
        assert_eq!(
            parse_publication_message(
                "[stable2606 Backport #13094] [Release|CI/CD] Fix runtimes publishing (#13158)"
            ),
            None
        );
    }

    #[test]
    fn parses_runtime_lock() {
        let lock = include_str!("../testing/index/runtimes.Cargo.lock");
        let parsed = parse_runtime_lock(lock);
        assert_eq!(
            parsed["staging-xcm-executor"],
            vec![Locked::Registry {
                v: "28.1.0".into(),
                line: 13
            }]
        );
        // A crate locked at two versions keeps both.
        assert_eq!(parsed["pallet-asset-conversion"].len(), 2);
        assert_eq!(
            parsed["pallet-individuality"],
            vec![Locked::Git(
                "git:e69b079ef93b6b0224ca81b96d4385f6dd4c8e22".into()
            )]
        );
        // Workspace-local runtimes are not crates.io packages.
        assert!(!parsed.contains_key("asset-hub-polkadot-runtime"));
    }

    #[test]
    fn parses_runtime_spec() {
        let lib = include_str!("../testing/index/runtime-lib.rs");
        assert_eq!(
            parse_runtime_spec("relay/polkadot/src/lib.rs", lib),
            Some(RuntimeSpec {
                path: "relay/polkadot/src/lib.rs".into(),
                spec_name: "polkadot".into(),
                spec_version: 2_005_001,
            })
        );
        assert_eq!(parse_runtime_spec("x", "fn main() {}"), None);
        assert!(is_runtime_lib_candidate("relay/kusama/src/lib.rs"));
        assert!(is_runtime_lib_candidate(
            "system-parachains/asset-hubs/asset-hub-polkadot/src/lib.rs"
        ));
        assert!(!is_runtime_lib_candidate(
            "relay/kusama/constants/src/lib.rs"
        ));
        assert!(!is_runtime_lib_candidate(
            "system-parachains/asset-hubs/asset-hub-kusama/primitives/src/lib.rs"
        ));
        assert!(!is_runtime_lib_candidate("pallets/foo/src/lib.rs"));
    }

    #[test]
    fn parses_manifests() {
        let root = r#"
[workspace]
resolver = "2"
members = ["substrate/frame/asset-conversion", "polkadot/xcm/xcm-executor"]
"#;
        assert_eq!(
            parse_workspace_members(root).unwrap(),
            vec![
                "substrate/frame/asset-conversion",
                "polkadot/xcm/xcm-executor"
            ]
        );
        let member = "[package]\nname = \"pallet-asset-conversion\"\nversion.workspace = true\n";
        assert_eq!(
            parse_package_name(member),
            Some("pallet-asset-conversion".into())
        );
        assert_eq!(parse_package_name("[workspace]\n"), None);
    }
}
