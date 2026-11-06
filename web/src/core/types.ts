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

export interface Meta {
  generatedAt: number;
  psvmVersion: string;
}
