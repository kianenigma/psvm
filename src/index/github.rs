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

//! Minimal authenticated GitHub client used by the indexer.

use serde_json::{json, Value};
use std::time::Duration;

type Error = Box<dyn std::error::Error + Send + Sync>;

/// A git tag resolved to the commit it points to.
#[derive(Debug, Clone)]
pub struct TagRef {
    pub name: String,
    pub sha: String,
    /// Committer date of the commit, RFC 3339.
    pub date: String,
}

/// A commit of a branch history.
#[derive(Debug, Clone)]
pub struct CommitRef {
    pub sha: String,
    pub date: String,
    pub message: String,
}

pub struct GitHub {
    client: reqwest::Client,
    token: String,
}

impl GitHub {
    pub fn new(token: String) -> Self {
        let client = reqwest::Client::builder()
            .user_agent("psvm-index")
            // Public RPCs require TLS 1.3, which native-tls lacks on macOS.
            .use_rustls_tls()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("static client config is valid");
        Self { client, token }
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
        let mut attempt = 0;
        loop {
            let response = request
                .try_clone()
                .expect("requests have no streaming body")
                .bearer_auth(&self.token)
                .send()
                .await;
            let retryable = match &response {
                Ok(r) => r.status().is_server_error() || r.status().as_u16() == 429,
                Err(e) => e.is_timeout() || e.is_connect(),
            };
            attempt += 1;
            if !retryable || attempt >= 4 {
                return Ok(response?);
            }
            tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
        }
    }

    /// `GET https://api.github.com{path}`; `Ok(None)` on 404/422.
    pub async fn rest(&self, path: &str) -> Result<Option<Value>, Error> {
        let request = self
            .client
            .get(format!("https://api.github.com{}", path))
            .header("Accept", "application/vnd.github+json");
        let response = self.send(request).await?;
        if matches!(response.status().as_u16(), 404 | 422) {
            return Ok(None);
        }
        Ok(Some(response.error_for_status()?.json().await?))
    }

    /// A file of `owner/repo` at `git_ref`; `Ok(None)` if it does not exist.
    pub async fn raw(
        &self,
        repo: &str,
        git_ref: &str,
        path: &str,
    ) -> Result<Option<String>, Error> {
        let url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}",
            repo, git_ref, path
        );
        let response = self.send(self.client.get(url)).await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(response.error_for_status()?.text().await?))
    }

    /// Runs a GraphQL query and returns its `data`. Errors next to data (e.g. one alias of a batch naming a number
    /// that is not a pull request) are logged and that field is `null`; errors without data fail.
    pub async fn graphql(&self, query: &str, variables: Value) -> Result<Value, Error> {
        let body = json!({ "query": query, "variables": variables });
        let request = self
            .client
            .post("https://api.github.com/graphql")
            .json(&body);
        let mut value: Value = self.send(request).await?.error_for_status()?.json().await?;
        let data = value["data"].take();
        if let Some(errors) = value.get("errors") {
            if data.is_null() {
                return Err(format!("GraphQL error: {}", errors).into());
            }
            log::debug!("GraphQL partial errors: {}", errors);
        }
        Ok(data)
    }

    /// All tags of `owner/repo`, with the commit (not annotated tag object) they point to.
    pub async fn tags(&self, owner: &str, repo: &str) -> Result<Vec<TagRef>, Error> {
        const QUERY: &str = r#"
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/tags/", first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target {
          ... on Commit { oid committedDate }
          ... on Tag { target { ... on Commit { oid committedDate } } }
        }
      }
    }
  }
}"#;
        let mut tags = vec![];
        let mut cursor: Option<String> = None;
        loop {
            let variables = json!({ "owner": owner, "name": repo, "cursor": cursor });
            let data = self.graphql(QUERY, variables).await?;
            let refs = &data["repository"]["refs"];
            for node in refs["nodes"].as_array().into_iter().flatten() {
                // Lightweight tags point to the commit, annotated tags to a tag object pointing
                // to it. Tags of trees or blobs have neither and are skipped.
                let target = &node["target"];
                let commit = if target["oid"].is_string() {
                    target
                } else {
                    &target["target"]
                };
                let (Some(sha), Some(date)) =
                    (commit["oid"].as_str(), commit["committedDate"].as_str())
                else {
                    continue;
                };
                tags.push(TagRef {
                    name: node["name"].as_str().unwrap_or_default().to_string(),
                    sha: sha.to_string(),
                    date: date.to_string(),
                });
            }
            if !refs["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false) {
                break;
            }
            cursor = refs["pageInfo"]["endCursor"].as_str().map(String::from);
        }
        Ok(tags)
    }

    /// Commits of `branch` since `since` (RFC 3339), newest first. `Ok(None)` if no such branch.
    pub async fn commits_since(
        &self,
        repo: &str,
        branch: &str,
        since: &str,
    ) -> Result<Option<Vec<CommitRef>>, Error> {
        let mut commits = vec![];
        for page in 1..=50 {
            let path = format!(
                "/repos/{}/commits?sha={}&since={}&per_page=100&page={}",
                repo, branch, since, page
            );
            let Some(value) = self.rest(&path).await? else {
                return Ok(None);
            };
            let items = value.as_array().cloned().unwrap_or_default();
            for item in &items {
                commits.push(CommitRef {
                    sha: item["sha"].as_str().unwrap_or_default().to_string(),
                    date: item["commit"]["committer"]["date"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    message: item["commit"]["message"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                });
            }
            if items.len() < 100 {
                break;
            }
        }
        Ok(Some(commits))
    }

    /// Head commit of `branch`.
    pub async fn branch_head(&self, repo: &str, branch: &str) -> Result<CommitRef, Error> {
        let value = self
            .rest(&format!("/repos/{}/commits/{}", repo, branch))
            .await?
            .ok_or_else(|| format!("branch {} of {} not found", branch, repo))?;
        Ok(CommitRef {
            sha: value["sha"].as_str().unwrap_or_default().to_string(),
            date: value["commit"]["committer"]["date"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            message: value["commit"]["message"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        })
    }

    /// Paths of all blobs of the tree at `sha`.
    pub async fn tree_paths(&self, repo: &str, sha: &str) -> Result<Vec<String>, Error> {
        let value = self
            .rest(&format!("/repos/{}/git/trees/{}?recursive=1", repo, sha))
            .await?
            .ok_or_else(|| format!("tree {} of {} not found", sha, repo))?;
        Ok(value["tree"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry["type"] == "blob")
            .filter_map(|entry| entry["path"].as_str().map(String::from))
            .collect())
    }

    /// `state_getRuntimeVersion` of a chain via its public JSON-RPC HTTP endpoint.
    /// A JSON-RPC call to a node's HTTP endpoint, returning `result`. Public RPCs sit behind Cloudflare, which answers
    /// bursts with an HTML challenge instead of JSON: those are retried after a pause.
    pub async fn rpc(&self, url: &str, method: &str, params: Value) -> Result<Value, Error> {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        for attempt in 0..5 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let sent = self
                .client
                .post(url)
                .timeout(Duration::from_secs(30))
                .json(&body)
                .send()
                .await;
            let text = match sent {
                Ok(response) => response.text().await.unwrap_or_default(),
                // Connection resets happen on the public RPCs; retry like a rate limit.
                Err(e) if attempt < 4 => {
                    log::debug!("{} {} failed (attempt {}): {}", url, method, attempt, e);
                    String::new()
                }
                Err(e) => return Err(e.into()),
            };
            if let Ok(mut value) = serde_json::from_str::<Value>(&text) {
                if let Some(error) = value.get("error") {
                    return Err(format!("{} {}: {}", url, method, error).into());
                }
                return Ok(value["result"].take());
            }
            log::debug!(
                "{} answered {} with no JSON (attempt {}), waiting",
                url,
                method,
                attempt
            );
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
        Err(format!("{} {}: no JSON answer after retries", url, method).into())
    }

    /// `POST` to the Subscan API with its key (never the GitHub token), returning `data`. Retries 429s and server
    /// errors; the free tier allows a few requests per second.
    pub async fn subscan(
        &self,
        host: &str,
        path: &str,
        key: &str,
        body: Value,
    ) -> Result<Value, Error> {
        let url = format!("https://{}.api.subscan.io{}", host, path);
        for attempt in 1..=4u32 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let response = self
                .client
                .post(&url)
                .header("X-API-Key", key)
                .timeout(Duration::from_secs(30))
                .json(&body)
                .send()
                .await?;
            let status = response.status();
            if (status.is_server_error() || status.as_u16() == 429) && attempt < 4 {
                tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                continue;
            }
            let mut value: Value = response.error_for_status()?.json().await?;
            if value["code"].as_i64() != Some(0) {
                return Err(
                    format!("Subscan {}: {} {}", path, value["code"], value["message"]).into(),
                );
            }
            return Ok(value["data"].take());
        }
        Err(format!("Subscan {}: no answer after retries", path).into())
    }

    pub async fn runtime_version(&self, rpc: &str) -> Result<(String, u32), Error> {
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "state_getRuntimeVersion", "params": []
        });
        let value: Value = self
            .client
            .post(rpc)
            .timeout(Duration::from_secs(20))
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let result = &value["result"];
        let name = result["specName"]
            .as_str()
            .ok_or_else(|| format!("no specName from {}: {}", rpc, value))?;
        let version = result["specVersion"]
            .as_u64()
            .ok_or_else(|| format!("no specVersion from {}: {}", rpc, value))?;
        Ok((name.to_string(), version as u32))
    }
}
