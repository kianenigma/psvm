// Shapes of the files written by `psvm index` (see `src/index/mod.rs` in the psvm crate).

export interface SdkRelease {
  /** Tag name, or `<release>@<sha12>` for untagged crates.io publications. */
  id: string;
  name: string;
  kind: 'tag' | 'untagged';
  sha: string;
  date: string;
  rc: boolean;
  aliases?: string[];
  publication?: string;
  source?: 'Plan.toml' | 'Cargo.lock';
  /** Commits on the line's branch since the previous release point, when known. */
  commits?: number;
}

export interface SdkLine {
  name: string;
  hasBranch: boolean;
  /** Oldest first. */
  releases: SdkRelease[];
}

export interface SdkReleases {
  lines: SdkLine[];
}

/** A crates.io lock (`v` + line of its `name =` entry in `Cargo.lock`), or `git:<rev>`. */
export type Locked = { v: string; line: number } | string;

export interface CrateShard {
  name: string;
  /** Release id -> version. */
  sdk: Record<string, string>;
  /** Version -> release id it originates from. */
  origins: Record<string, string>;
  /** Runtimes release -> locks. */
  runtimes: Record<string, Locked[]>;
}

export interface RuntimeSpec {
  path: string;
  specName: string;
  specVersion: number;
}

export interface RuntimesRelease {
  /** Tag or `main`. Newest first, `main` on top. */
  name: string;
  sha: string;
  date: string;
  specs: RuntimeSpec[];
  /** The polkadot-sdk release whose crate versions match the most locked crates. */
  sdkRelease?: { id: string; matched: number; total: number };
}

export interface LiveSpec {
  chain: string;
  rpc: string;
  specName: string;
  specVersion: number;
  releases: string[];
}

/** An open runtimes PR that releases a version when merged (it renames `[Unreleased]` in CHANGELOG.md). */
export interface PendingRelease {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  createdAt: string;
  headSha: string;
  version: string;
  specs: RuntimeSpec[];
  /** The polkadot-sdk release the PR's `Cargo.lock` matches best. */
  sdkRelease?: { id: string; matched: number; total: number };
}

/** A master PR released on an older stable line that some newer stable lines do not have. */
export interface MissedPr {
  number: number;
  title: string;
  mergedAt: string;
  /** Older lines, with the id of the first release of each that has it. */
  released: { line: string; release: string }[];
  /** Newer lines with no final release that has it. Their branch may have a backport of it that is not released yet. */
  missing: string[];
}

/** The runtime a Westend chain runs (see `src/index/westend.rs`). */
export interface WestendRuntime {
  chain: string;
  rpc: string;
  specName: string;
  specVersion: number;
  /** First block running this spec version, and its time; absent if older than the indexer's search window. */
  sinceBlock?: number | null;
  since?: string | null;
  /** The polkadot-sdk commit remarked on chain with the upgrade; absent for upgrades without a remark. */
  commit?: string | null;
  /** The relay chain extrinsic (`block-index`) carrying the remark. */
  extrinsic?: string | null;
}

/** An upgrade the Westend sudo key authorized on the relay chain, from `westend-upgrades.json` (newest first). */
export interface WestendUpgrade {
  chain: string;
  /** The relay chain extrinsic (`block-index`) that authorized it. */
  extrinsic: string;
  time: string | null;
  codeHash: string | null;
  /** The polkadot-sdk commit remarked with it, and its title. */
  commit: string | null;
  title: string | null;
}

/** `unpublished-backports.json`: per line with a branch, the backports merged into it after its latest final release. */
export interface UnpublishedLine {
  line: string;
  /** Id of the line's latest final release, which the backports came after; `null` if it has none yet. */
  after: string | null;
  /** Newest first. */
  backports: {
    sha: string;
    /** The backport PR. */
    number: number;
    title: string;
    mergedAt: string | null;
    /** The `master` PRs it backports. */
    backportOf: number[];
    /** The published crates its prdoc bumps; empty if it changes none (no prdoc). Absent in older indexes. */
    crates?: string[];
  }[];
}

export interface Meta {
  generatedAt: number;
  psvmVersion: string;
}
