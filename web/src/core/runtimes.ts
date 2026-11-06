import { type CommitRange, commitRange, type OpenPr, openBackports } from './backports';
import { type Http, RUNTIMES_REPO } from './http';
import type { LiveSpec, RuntimesRelease, SdkRelease, SdkReleases } from './types';

/** The polkadot-sdk release a runtimes release is built against, and what its line has since. */
export interface RuntimesSdk {
  release: SdkRelease;
  line: string;
  matched: number;
  total: number;
  /** Non-rc releases of the same line after `release`. */
  newer: SdkRelease[];
  openBackports: OpenPr[];
}

export interface RuntimesReleaseRow {
  release: RuntimesRelease;
  sdk: RuntimesSdk | null;
  live: LiveSpec[];
}

/**
 * A live chain compared with the latest runtimes release: `current` when it runs that release's spec version, `behind`
 * when the release has a higher one (an upgrade is pending), `unknown` when the release has no runtime of that name.
 */
export interface ChainStatus {
  spec: LiveSpec;
  /** The runtimes release (tag) whose spec version the chain runs, if any. */
  release: string | null;
  status: 'current' | 'behind' | 'unknown';
  /** Spec version of this runtime in the latest release. */
  latestVersion: number | null;
}

export interface RuntimesOverview {
  /** The newest tagged release. */
  latest: RuntimesReleaseRow | null;
  /** Newest first, `main` on top. */
  rows: RuntimesReleaseRow[];
  chains: ChainStatus[];
  /** Commits on `main` since the latest release. */
  unreleased: CommitRange | null;
}

/**
 * The state of the fellowship runtimes, independent of any PR: releases with the polkadot-sdk release each builds on,
 * the chains running them (as of the index build), and what `main` has that is not released yet. Two to four API calls:
 * open backports (search) and the commits since the latest release.
 */
export async function runtimesOverview(http: Http): Promise<RuntimesOverview> {
  const [runtimes, releases, live, open] = await Promise.all([
    http.data<RuntimesRelease[]>('runtimes-releases.json'),
    http.data<SdkReleases>('sdk-releases.json'),
    http.data<LiveSpec[]>('live-specs.json'),
    openBackports(http),
  ]);
  if (!runtimes || !releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');

  const sdkOf = (release: RuntimesRelease): RuntimesSdk | null => {
    const match = release.sdkRelease;
    if (!match) return null;
    for (const line of releases.lines) {
      const index = line.releases.findIndex((r) => r.id === match.id);
      if (index < 0) continue;
      return {
        ...match,
        release: line.releases[index],
        line: line.name,
        newer: line.releases.slice(index + 1).filter((r) => !r.rc),
        openBackports: open.filter((pr) => pr.base === line.name),
      };
    }
    return null;
  };
  const rows = runtimes.map((release) => ({
    release,
    sdk: sdkOf(release),
    live: (live ?? []).filter((spec) => spec.releases.includes(release.name)),
  }));

  const latest = rows.find((row) => row.release.name !== 'main') ?? null;
  const chains = (live ?? []).map((spec): ChainStatus => {
    const latestVersion = latest?.release.specs.find((s) => s.specName === spec.specName)?.specVersion ?? null;
    const status = latestVersion === null ? 'unknown' : spec.specVersion >= latestVersion ? 'current' : 'behind';
    return { spec, release: spec.releases.find((r) => r !== 'main') ?? null, status, latestVersion };
  });

  const unreleased = latest
    ? await commitRange(http, RUNTIMES_REPO, [latest.release.sha, latest.release.name], ['main', 'main'])
    : null;
  return { latest, rows, chains, unreleased };
}
