# Plan: track Individuality in "Where is my PR?"

Status: not started. Written 2026-11-06 for later. Individuality (`paritytech/individuality-community`, "indiv") may
be merged into polkadot-sdk soon; until then it is a separate dependency of the fellowship runtimes worth tracking.

## Background

- Indiv has no release process. Its GitHub releases and `nightly-*` tags are mostly for Paseo, not mainnet.
- Mainnet runtimes pin indiv by git `rev` in `polkadot-fellows/runtimes` `Cargo.toml`. The intended flow: branch off
  the pinned commit, bump its polkadot-sdk deps to the stable release the runtimes use (e.g. `stable2606-5`), add any
  backports needed for mainnet, tag it, and pin runtimes to the new commit. That branch is the "indiv parallel" of an
  sdk release line.

## Facts checked on 2026-11-06

- Fellows `main` pins `e69b079ef93b6b0224ca81b96d4385f6dd4c8e22` ("Bump verifiable to 0.4.1 (#200)", 2026-10-23),
  the same `rev =` for 18 `indiv-*` crates (`Cargo.toml` ~line 94). In `Cargo.lock` these show as
  `source = "git+https://github.com/paritytech/individuality-community?rev=<sha>#<sha>"`; the indexer already records
  them as `git:<rev>` locks.
- That commit is on indiv `main` (10 behind its head) and on branch `backport-sdk-2606-5` (1 behind).
- Tags exist in both styles: `v0.3.x`, `sdk-2606-5-3004004` (looks like `sdk-YYMM-N-<spec version>`), and
  `nightly-YYYY-MM-DD-<spec version>`.
- Indiv takes polkadot-sdk crates from crates.io (`frame-support = { version = "48.1.0" }`), not git. So the existing
  `matching_sdk_release` logic (best match of locked crate versions against the index) applies to indiv's `Cargo.lock`
  unchanged.
- The repo is public, so the browser can call the GitHub API for it without a token (subject to rate limits).

## Proposed features

Cheap, mostly in the indexer (`psvm index`):

1. **Pinned indiv commit per runtimes release** (tags and `main`): sha, date, title, and which indiv refs contain it
   (`main`, `backport-sdk-*`, tags). Highlight releases where the pin changed.
2. **The polkadot-sdk release that indiv commit builds on**, via `matching_sdk_release` on indiv's `Cargo.lock` at the
   pinned commit ("N of M crates match").
3. **Mismatch warning**: flag when indiv's sdk release differs from the runtimes release's. Better: list the sdk crates
   locked at two versions in the runtimes `Cargo.lock` (e.g. two `pallet-revive` versions), which is the
   incompatibility seen when indiv and runtimes are on different sdk releases.

Live in the browser (a few API calls each, reusing `commitRange` from `web/src/core/backports.ts`):

4. **What the runtimes do not have yet**: commits on indiv `main` since the pinned commit (count, newest 5, GitHub
   compare link); commits on the current backport branch since the pin (queued for mainnet); open PRs into that branch.
5. **"Where is my indiv PR?"**: an indiv PR number gives the runtimes releases whose pinned commit contains it, reusing
   the compare-based containment check from `web/src/core/lookup.ts`.

Needs a convention first:

6. **Indiv release lines**: if branches are always `backport-sdk-YYMM-N` and tags `sdk-YYMM-N-<spec>`, show them as
   lines on the rail view next to the matching sdk line. Without fixed naming this is guesswork.

Optional:

7. **Paseo**: show which indiv tag Paseo runs, by reading its People chain spec version over RPC (as `live-specs.json`
   does for mainnet) and matching it to the `<spec version>` suffix of the tags. Needs the Paseo People RPC URL.

## Suggested shape

- One page, `#/individuality`, with 1–5. Add 6 once naming is fixed.
- Indexer output: `indiv.json` with, per runtimes release, `{rev, date, title, refs, sdkRelease{id, matched, total},
  duplicateCrates[]}`.
- If indiv moves into polkadot-sdk: 1–3 become a section of the runtimes page, and 5 folds into the normal PR trace.
