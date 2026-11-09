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

//! Which polkadot-sdk commit each Westend chain runs.
//!
//! Westend is upgraded by `paritytech/substrate-runtime-upgrade`, which signs
//! `utility.batch_all([system.remark_with_event(<commit>), sudo.sudo(<authorize_upgrade>)])` on the relay chain (for
//! a parachain the authorization goes there by XCM) and then applies the code on the target chain. So per chain:
//! 1. binary search the first block running the live spec version (the upgrade),
//! 2. binary search the block where `System::AuthorizedUpgrade` was set before it (absent when the upgrade was a plain
//!    `sudo(system.set_code)`, which records no commit),
//! 3. find the batch with the remark in that relay block, or the relay blocks just before the parachain's one.
//!
//! RPC only (no indexer service); results are cached per chain and spec version, so this runs once per upgrade.

use super::{github::GitHub, Cache, Error, SDK_REPO};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const RELAY_RPC: &str = "https://westend-rpc.polkadot.io";

/// Chain name, RPC and para id (`None` for the relay chain); the relay chain first.
const CHAINS: &[(&str, &str, Option<u64>)] = &[
    ("Westend", RELAY_RPC, None),
    (
        "Westend Asset Hub",
        "https://westend-asset-hub-rpc.polkadot.io",
        Some(1000),
    ),
    (
        "Westend Bridge Hub",
        "https://westend-bridge-hub-rpc.polkadot.io",
        Some(1002),
    ),
    (
        "Westend Collectives",
        "https://westend-collectives-rpc.polkadot.io",
        Some(1001),
    ),
    (
        "Westend Coretime",
        "https://westend-coretime-rpc.polkadot.io",
        Some(1005),
    ),
    (
        "Westend People",
        "https://westend-people-rpc.polkadot.io",
        Some(1004),
    ),
];

/// `:code`, the runtime blob: its storage hash is the code hash `system.authorize_upgrade` names.
const CODE: &str = "0x3a636f6465";
/// `twox128("Sudo") ++ twox128("Key")`.
const SUDO_KEY: &str = "0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b";

/// `twox128("Timestamp") ++ twox128("Now")`.
const TIMESTAMP_NOW: &str = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
/// `twox128("System") ++ twox128("AuthorizedUpgrade")`.
const AUTHORIZED_UPGRADE: &str =
    "0x26aa394eea5630e07c48ae0c9558cef72fa9f1bf25567808771bff091dc89ecd";
/// `twox128("ParachainSystem") ++ twox128("PendingValidationCode")`: on a parachain, set from the applied upgrade
/// until the relay chain lets it take effect.
const PENDING_VALIDATION_CODE: &str =
    "0x45323df7cc47150b3930e2666b0aa31390d171f8401887cf06fb43a732994c32";
/// How many of the latest upgrades `westend-upgrades.json` lists.
const UPGRADE_HISTORY: usize = 30;
/// How far back (in blocks) to look for the upgrade and its authorization.
const UPGRADE_WINDOW: u64 = 2_000_000;
const AUTHORIZE_WINDOW: u64 = 200_000;
/// Relay blocks around the parachain's authorization (by timestamp) to search for the batch: XCM takes a block or two,
/// and a parachain block's timestamp runs a few blocks ahead of its inclusion.
const RELAY_SCAN: u64 = 20;

/// The runtime a Westend chain runs, as written to `westend.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WestendRuntime {
    pub chain: String,
    pub rpc: String,
    #[serde(rename = "specName")]
    pub spec_name: String,
    #[serde(rename = "specVersion")]
    pub spec_version: u32,
    /// First block running this spec version, and its time (RFC 3339); unknown if older than the search window.
    #[serde(rename = "sinceBlock")]
    pub since_block: Option<u64>,
    pub since: Option<String>,
    /// The polkadot-sdk commit remarked with the upgrade, resolved to its full sha.
    pub commit: Option<String>,
    /// The relay chain extrinsic (`block-index`) carrying the remark.
    pub extrinsic: Option<String>,
}

/// An upgrade the Westend sudo key authorized, as written to `westend-upgrades.json`. Only known from Subscan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WestendUpgrade {
    pub chain: String,
    /// The relay chain extrinsic (`block-index`) that authorized it.
    pub extrinsic: String,
    /// Time of that extrinsic (RFC 3339).
    pub time: Option<String>,
    #[serde(rename = "codeHash")]
    pub code_hash: Option<String>,
    /// The polkadot-sdk commit remarked with it (a full sha when GitHub knows it), and its title.
    pub commit: Option<String>,
    pub title: Option<String>,
}

/// What the indexer learns about Westend.
#[derive(Debug, Default)]
pub struct Westend {
    pub runtimes: Vec<WestendRuntime>,
    /// The latest upgrades, newest first; empty without a Subscan API key.
    pub upgrades: Vec<WestendUpgrade>,
}

#[derive(Clone, Copy)]
struct Node<'a> {
    gh: &'a GitHub,
    url: &'a str,
}

impl Node<'_> {
    async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        self.gh.rpc(self.url, method, params).await
    }

    async fn hash(&self, n: u64) -> Result<Value, Error> {
        self.call("chain_getBlockHash", json!([n])).await
    }

    async fn head(&self) -> Result<u64, Error> {
        let header = self.call("chain_getHeader", json!([])).await?;
        Ok(u64::from_str_radix(
            header["number"]
                .as_str()
                .unwrap_or("0x0")
                .trim_start_matches("0x"),
            16,
        )?)
    }

    async fn spec_at(&self, n: u64) -> Result<(String, u32), Error> {
        let v = self
            .call("state_getRuntimeVersion", json!([self.hash(n).await?]))
            .await?;
        Ok((
            v["specName"].as_str().unwrap_or_default().to_string(),
            v["specVersion"].as_u64().unwrap_or_default() as u32,
        ))
    }

    async fn storage_at(&self, key: &str, n: u64) -> Result<Option<String>, Error> {
        let v = self
            .call("state_getStorage", json!([key, self.hash(n).await?]))
            .await?;
        Ok(v.as_str().map(String::from))
    }

    /// Whether `key` has a value at block `n`, without downloading it (the pending code is megabytes).
    async fn exists_at(&self, key: &str, n: u64) -> Result<bool, Error> {
        let hash = self
            .call("state_getStorageHash", json!([key, self.hash(n).await?]))
            .await?;
        Ok(!hash.is_null())
    }

    /// Whether an upgrade is under way at block `n`: authorized, or applied and pending on a parachain.
    async fn upgrading_at(&self, n: u64) -> Result<bool, Error> {
        Ok(self.exists_at(AUTHORIZED_UPGRADE, n).await?
            || self.exists_at(PENDING_VALIDATION_CODE, n).await?)
    }

    /// `Timestamp::Now` at block `n`, in milliseconds.
    async fn time_at(&self, n: u64) -> Result<u64, Error> {
        let raw = self.storage_at(TIMESTAMP_NOW, n).await?.unwrap_or_default();
        let bytes = decode_hex(raw.trim_start_matches("0x")).unwrap_or_default();
        Ok(bytes
            .iter()
            .rev()
            .fold(0u64, |acc, b| (acc << 8) | *b as u64))
    }

    async fn extrinsics(&self, n: u64) -> Result<Vec<String>, Error> {
        let block = self
            .call("chain_getBlock", json!([self.hash(n).await?]))
            .await?;
        Ok(block["block"]["extrinsics"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|x| x.as_str().map(String::from))
            .collect())
    }

    /// The first block in `(lo, hi]` for which `pred` holds, given it holds at `hi`, not at `lo`, and flips once.
    async fn first_block<F, Fut>(&self, mut lo: u64, mut hi: u64, pred: F) -> Result<u64, Error>
    where
        F: Fn(u64) -> Fut,
        Fut: std::future::Future<Output = Result<bool, Error>>,
    {
        while hi - lo > 1 {
            let mid = lo + (hi - lo) / 2;
            if pred(mid).await? {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Ok(hi)
    }
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// The commit text of a `utility.batch_all([system.remark_with_event(<commit>), ..])` call in an extrinsic: 10 or 40
/// ASCII hex characters, or 20 raw bytes. Westend encodes `batch_all` as `0x10 0x02`, `remark_with_event` as
/// `0x00 0x07`.
pub fn remarked_commit(extrinsic: &str) -> Option<String> {
    let at = extrinsic.find("1002080007")? + 10;
    let rest = extrinsic.get(at..)?;
    let (len, data) = (
        u8::from_str_radix(rest.get(..2)?, 16).ok()? >> 2,
        rest.get(2..)?,
    );
    let bytes = decode_hex(data.get(..len as usize * 2)?)?;
    let text = String::from_utf8(bytes.clone()).unwrap_or_default();
    let text = text.trim_start_matches("0x");
    if matches!(text.len(), 10 | 40) && text.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(text.to_ascii_lowercase())
    } else if bytes.len() == 20 {
        Some(bytes.iter().map(|b| format!("{:02x}", b)).collect())
    } else {
        None
    }
}

async fn runtime(
    gh: &GitHub,
    cache: &Cache,
    chain: &str,
    url: &str,
) -> Result<WestendRuntime, Error> {
    let node = Node { gh, url };
    let head = node.head().await?;
    let (spec_name, spec_version) = node.spec_at(head).await?;
    let key = format!("{}-{}", spec_name, spec_version);
    if let Some(cached) = cache.get::<WestendRuntime>("westend", &key) {
        return Ok(cached);
    }
    let mut out = WestendRuntime {
        chain: chain.into(),
        rpc: url.into(),
        spec_name,
        spec_version,
        since_block: None,
        since: None,
        commit: None,
        extrinsic: None,
    };

    let lo = head.saturating_sub(UPGRADE_WINDOW);
    if node.spec_at(lo).await?.1 == spec_version {
        log::warn!(
            "{}: spec {} is older than the search window",
            chain,
            spec_version
        );
        return Ok(out);
    }
    let upgrade = node
        .first_block(lo, head, |n| async move {
            Ok(node.spec_at(n).await?.1 == spec_version)
        })
        .await?;
    let time = node.time_at(upgrade).await?;
    out.since_block = Some(upgrade);
    out.since = chrono_like(time);

    // From the authorization until the upgrade, an upgrade is under way; a plain `set_code` has no such window.
    if node.upgrading_at(upgrade - 1).await? {
        // Search from the previous upgrade on: before it, that upgrade's own authorization was under way.
        let window = upgrade.saturating_sub(AUTHORIZE_WINDOW);
        let previous = node.spec_at(upgrade - 1).await?.1;
        let from = if node.spec_at(window).await?.1 >= previous {
            window
        } else {
            node.first_block(window, upgrade - 1, |n| async move {
                Ok(node.spec_at(n).await?.1 >= previous)
            })
            .await?
        };
        let authorized = node
            .first_block(
                from,
                upgrade - 1,
                |n| async move { node.upgrading_at(n).await },
            )
            .await?;
        let relay = Node { gh, url: RELAY_RPC };
        let relay_block = if url == RELAY_RPC {
            authorized
        } else {
            let at = node.time_at(authorized).await?;
            let relay_head = relay.head().await?;
            let lo = relay_head.saturating_sub(UPGRADE_WINDOW);
            relay
                .first_block(lo, relay_head, |n| async move {
                    Ok(relay.time_at(n).await? >= at)
                })
                .await?
        };
        log::debug!(
            "{}: authorized at block {}, relay block {}",
            chain,
            authorized,
            relay_block
        );
        'scan: for n in (relay_block.saturating_sub(RELAY_SCAN)..=relay_block + RELAY_SCAN).rev() {
            for (i, xt) in relay.extrinsics(n).await?.iter().enumerate() {
                if let Some(commit) = remarked_commit(xt) {
                    out.extrinsic = Some(format!("{}-{}", n, i));
                    let resolved = gh
                        .rest(&format!("/repos/{}/commits/{}", SDK_REPO, commit))
                        .await?;
                    out.commit = Some(
                        resolved
                            .and_then(|c| c["sha"].as_str().map(String::from))
                            .unwrap_or(commit),
                    );
                    break 'scan;
                }
            }
        }
    }
    log::info!(
        "{}: spec {} since block {}, commit {:?}",
        chain,
        out.spec_version,
        upgrade,
        out.commit
    );
    cache.put("westend", &key, &out)?;
    Ok(out)
}

/// Milliseconds since the epoch as RFC 3339 (UTC, seconds precision).
fn chrono_like(ms: u64) -> Option<String> {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (ms > 0).then(|| {
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
            year,
            month,
            day,
            rem / 3600,
            rem % 3600 / 60,
            rem % 60
        )
    })
}

/// An upgrade batch the sudo key signed on the relay chain, as decoded by Subscan; cached by extrinsic index.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpgradeBatch {
    pub extrinsic: String,
    /// Block time, in seconds.
    pub time: u64,
    /// The parachain it upgrades; `None` for the relay chain.
    pub para: Option<u64>,
    pub code_hash: Option<String>,
    /// The remarked commit, resolved to a full sha when GitHub knows it.
    pub commit: Option<String>,
}

/// The first object in `value` (depth first) whose `call_name` is `name`.
fn find_call<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) if map.get("call_name").and_then(Value::as_str) == Some(name) => {
            Some(value)
        }
        Value::Object(map) => map.values().find_map(|v| find_call(v, name)),
        Value::Array(items) => items.iter().find_map(|v| find_call(v, name)),
        _ => None,
    }
}

/// The first value under key `key` in `value` (depth first).
fn find_key<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map
            .get(key)
            .or_else(|| map.values().find_map(|v| find_key(v, key))),
        Value::Array(items) => items.iter().find_map(|v| find_key(v, key)),
        _ => None,
    }
}

/// Reads remark, target and code hash from the decoded `params` of a `utility.batch_all` extrinsic. For a parachain
/// the authorization is SCALE inside an XCM `Transact`: `system.authorize_upgrade` (`0x0009`) and the 32-byte hash.
pub fn parse_batch(extrinsic: &str, time: u64, params: &Value) -> UpgradeBatch {
    let param = |call: &Value, name: &str| {
        call["params"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["name"] == name)
            .and_then(|p| p["value"].as_str())
            .map(String::from)
    };
    let commit = find_call(params, "remark_with_event")
        .and_then(|c| param(c, "remark"))
        .map(|r| r.trim_start_matches("0x").to_ascii_lowercase())
        .filter(|r| matches!(r.len(), 10 | 40) && r.bytes().all(|b| b.is_ascii_hexdigit()));
    let code_hash = find_call(params, "authorize_upgrade")
        .and_then(|c| param(c, "code_hash"))
        .or_else(|| {
            let call = find_key(params, "Transact")?["call"].as_str()?;
            let hash = call.strip_prefix("0x0009")?;
            (hash.len() == 64).then(|| format!("0x{}", hash))
        });
    UpgradeBatch {
        extrinsic: extrinsic.into(),
        time,
        para: find_key(params, "Parachain").and_then(Value::as_u64),
        code_hash,
        commit,
    }
}

/// All upgrade batches of Westend's sudo key, newest first, from Subscan.
async fn subscan_batches(
    gh: &GitHub,
    cache: &Cache,
    key: &str,
) -> Result<Vec<UpgradeBatch>, Error> {
    let sudo = gh
        .rpc(RELAY_RPC, "state_getStorage", json!([SUDO_KEY]))
        .await?;
    let sudo = sudo.as_str().ok_or("Westend has no sudo key")?;
    let mut batches = vec![];
    for page in 0..20 {
        let body = json!({ "address": sudo, "module": "utility", "call": "batch_all", "row": 25, "page": page });
        let data = gh
            .subscan("westend", "/api/v2/scan/extrinsics", key, body)
            .await?;
        let listed = data["extrinsics"].as_array().cloned().unwrap_or_default();
        for item in &listed {
            let index = item["extrinsic_index"].as_str().unwrap_or_default();
            if let Some(batch) = cache.get::<UpgradeBatch>("subscan-batch", index) {
                batches.push(batch);
                continue;
            }
            let detail = gh
                .subscan(
                    "westend",
                    "/api/scan/extrinsic",
                    key,
                    json!({ "extrinsic_index": index }),
                )
                .await?;
            let mut batch = parse_batch(
                index,
                item["block_timestamp"].as_u64().unwrap_or_default(),
                &detail["params"],
            );
            if let Some(commit) = &batch.commit {
                let resolved = gh
                    .rest(&format!("/repos/{}/commits/{}", SDK_REPO, commit))
                    .await?;
                if let Some(sha) = resolved.and_then(|c| c["sha"].as_str().map(String::from)) {
                    batch.commit = Some(sha);
                }
            }
            cache.put("subscan-batch", index, &batch)?;
            batches.push(batch);
        }
        if listed.len() < 25 {
            break;
        }
    }
    log::info!(
        "Subscan: {} upgrade batches of the Westend sudo key",
        batches.len()
    );
    Ok(batches)
}

/// The name of the chain with para id `para` (`None`: the relay chain).
fn chain_name(para: Option<u64>) -> String {
    CHAINS.iter().find(|(_, _, p)| *p == para).map_or_else(
        || format!("Westend parachain {}", para.unwrap_or_default()),
        |(name, _, _)| name.to_string(),
    )
}

/// The first line of a polkadot-sdk commit's message; cached by sha (`None` if GitHub does not know the commit).
async fn commit_title(gh: &GitHub, cache: &Cache, sha: &str) -> Result<Option<String>, Error> {
    if let Some(title) = cache.get::<Option<String>>("commit-title", sha) {
        return Ok(title);
    }
    let title = gh
        .rest(&format!("/repos/{}/commits/{}", SDK_REPO, sha))
        .await?
        .and_then(|c| {
            c["commit"]["message"]
                .as_str()
                .and_then(|m| m.lines().next())
                .map(String::from)
        });
    cache.put("commit-title", sha, &title)?;
    Ok(title)
}

/// The latest `UPGRADE_HISTORY` upgrades among `batches` (newest first): those that authorize code.
async fn upgrades(gh: &GitHub, cache: &Cache, batches: &[UpgradeBatch]) -> Vec<WestendUpgrade> {
    let mut out = vec![];
    for batch in batches
        .iter()
        .filter(|b| b.code_hash.is_some())
        .take(UPGRADE_HISTORY)
    {
        let title = match &batch.commit {
            Some(sha) => commit_title(gh, cache, sha).await.unwrap_or_else(|e| {
                log::warn!("title of Westend commit {}: {:?}", sha, e);
                None
            }),
            None => None,
        };
        out.push(WestendUpgrade {
            chain: chain_name(batch.para),
            extrinsic: batch.extrinsic.clone(),
            time: chrono_like(batch.time * 1000),
            code_hash: batch.code_hash.clone(),
            commit: batch.commit.clone(),
            title,
        });
    }
    out
}

/// A chain's runtime from the batch that authorized its live code, if any.
async fn runtime_from_batch(
    gh: &GitHub,
    batches: &[UpgradeBatch],
    (chain, url, para): (&str, &str, Option<u64>),
) -> Result<Option<WestendRuntime>, Error> {
    let node = Node { gh, url };
    let code_hash = node.call("state_getStorageHash", json!([CODE])).await?;
    let Some(batch) = batches
        .iter()
        .find(|b| b.para == para && b.code_hash.as_deref() == code_hash.as_str())
    else {
        return Ok(None);
    };
    let (spec_name, spec_version) = node.spec_at(node.head().await?).await?;
    log::info!(
        "{}: spec {} authorized by {}, commit {:?}",
        chain,
        spec_version,
        batch.extrinsic,
        batch.commit
    );
    Ok(Some(WestendRuntime {
        chain: chain.into(),
        rpc: url.into(),
        spec_name,
        spec_version,
        since_block: None,
        since: chrono_like(batch.time * 1000),
        commit: batch.commit.clone(),
        extrinsic: Some(batch.extrinsic.clone()),
    }))
}

/// The runtime of every Westend chain; chains whose RPC fails are logged and left out. With a Subscan API key, a
/// chain whose live code was authorized by a remarked batch is read from that batch; the others (and all chains
/// without a key) are found by searching the chain over RPC. The upgrade history needs the key.
pub async fn westend(gh: &GitHub, cache: &Cache, subscan_key: Option<&str>) -> Westend {
    let batches = match subscan_key {
        Some(key) => subscan_batches(gh, cache, key).await.unwrap_or_else(|e| {
            log::warn!("Subscan unavailable, searching Westend over RPC: {:?}", e);
            vec![]
        }),
        None => vec![],
    };
    let mut out = vec![];
    // One chain at a time: the public RPCs rate limit bursts.
    for &(chain, url, para) in CHAINS {
        let from_batch = match runtime_from_batch(gh, &batches, (chain, url, para)).await {
            Ok(found) => found,
            Err(e) => {
                log::warn!("{}: Westend runtime unavailable: {:?}", chain, e);
                continue;
            }
        };
        let runtime = match from_batch {
            Some(r) => Ok(r),
            None => runtime(gh, cache, chain, url).await,
        };
        match runtime {
            Ok(r) => out.push(r),
            Err(e) => log::warn!("{}: Westend runtime unavailable: {:?}", chain, e),
        }
    }
    Westend {
        runtimes: out,
        upgrades: upgrades(gh, cache, &batches).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_remarked_commit() {
        // Relay extrinsic 33597789-2: batch_all([remark_with_event("ce5174d790"), sudo(xcm send(..))]).
        let xt = "0xc902840002450a52aee25e189c4139993620bfdc893b1d120504eb9e87cf8a6437c4614101de52ff73a788069186893cbb8e6cec691166a4c93e889c1cfe41f24f4183da633a10e6e730bfe91dc56aa8eb7e7437a1eaaa9358e1db173acdfc9ee4ad0145829501fd030000100208000728636535313734643739301500630004000100a10f04082f00000602e2608c0a00880009c7a91f4aafad7a00424bf9d5c8029f2fac2b6ea87ee7ece41fcd3825a5aa8bfd";
        assert_eq!(remarked_commit(xt).as_deref(), Some("ce5174d790"));
        assert_eq!(remarked_commit("0x0102"), None);
    }

    #[test]
    fn decodes_subscan_batches() {
        // Subscan's decoding of relay extrinsic 33597789-2 (trimmed).
        let params = serde_json::json!([{ "name": "calls", "value": [
            { "call_module": "System", "call_name": "remark_with_event",
              "params": [{ "name": "remark", "value": "ce5174d790" }] },
            { "call_module": "Sudo", "call_name": "sudo", "params": [{ "name": "call", "value": {
                "call_module": "XcmPallet", "call_name": "send", "params": [
                    { "name": "dest", "value": { "V4": { "interior": { "X1": [{ "Parachain": 1000 }] }, "parents": 0 } } },
                    { "name": "message", "value": { "V4": [
                        { "UnpaidExecution": { "check_origin": null } },
                        { "Transact": { "call": "0x0009c7a91f4aafad7a00424bf9d5c8029f2fac2b6ea87ee7ece41fcd3825a5aa8bfd" } }
                    ] } }
                ] } }] }
        ] }]);
        let batch = parse_batch("33597789-2", 1_793_796_804, &params);
        assert_eq!(batch.commit.as_deref(), Some("ce5174d790"));
        assert_eq!(batch.para, Some(1000));
        assert_eq!(
            batch.code_hash.as_deref(),
            Some("0xc7a91f4aafad7a00424bf9d5c8029f2fac2b6ea87ee7ece41fcd3825a5aa8bfd")
        );
    }

    #[test]
    fn names_chains_by_para_id() {
        assert_eq!(chain_name(None), "Westend");
        assert_eq!(chain_name(Some(1000)), "Westend Asset Hub");
        assert_eq!(chain_name(Some(2000)), "Westend parachain 2000");
    }

    #[test]
    fn formats_timestamps() {
        assert_eq!(
            chrono_like(1_793_797_464_000).as_deref(),
            Some("2026-11-04T13:04:24Z")
        );
        assert_eq!(chrono_like(0), None);
    }
}
