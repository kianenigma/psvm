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
  /** Newer lines with no release or branch commit that has it. */
  missing: string[];
}

export interface Meta {
  generatedAt: number;
  psvmVersion: string;
}
