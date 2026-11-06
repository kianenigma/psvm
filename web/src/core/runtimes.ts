import { type CommitRange, commitRange, type OpenPr, openBackports, refOf, sdkReleases } from './backports';
import { type Http, RUNTIMES_REPO, SDK_REPO } from './http';
import type { LiveSpec, PendingRelease, RuntimesRelease, SdkLine, SdkRelease } from './types';

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
    sdkReleases(http),
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

/** A polkadot-sdk release point with its line. */
export interface SdkPoint {
  release: SdkRelease;
  line: string;
  lineData: SdkLine;
  /** Non-rc releases of the line after this one. */
  newer: SdkRelease[];
  openBackports: OpenPr[];
}

export type PendingReleasePage =
  | { status: 'not-found'; number: number }
  | {
      status: 'found';
      pr: PendingRelease;
      /** Live state of the PR: it may have been merged or closed since the index was built. */
      state: 'open' | 'merged' | 'closed';
      /** The latest runtimes release, which the PR replaces. */
      previous: RuntimesRelease | null;
      before: SdkPoint | null;
      after: SdkPoint | null;
      /** polkadot-sdk commits from `before` to `after`. */
      sdkChanges: CommitRange | null;
    };

/**
 * A pending runtimes release (found by the indexer): the polkadot-sdk release it moves the runtimes to, compared with
 * the one the latest release uses. Three to five API calls: the PR state, open backports, and the commits between.
 */
export async function pendingReleasePage(http: Http, number: number): Promise<PendingReleasePage> {
  const [pending, runtimes, releases, open, livePr] = await Promise.all([
    http.data<PendingRelease[]>('pending-releases.json'),
    http.data<RuntimesRelease[]>('runtimes-releases.json'),
    sdkReleases(http),
    openBackports(http),
    http.api<{ state: string; merged_at: string | null }>(`/repos/${RUNTIMES_REPO}/pulls/${number}`),
  ]);
  if (!runtimes || !releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const pr = (pending ?? []).find((p) => p.number === number);
  if (!pr) return { status: 'not-found', number };

  const point = (id: string | undefined): SdkPoint | null => {
    for (const line of releases.lines) {
      const index = line.releases.findIndex((r) => r.id === id);
      if (index < 0) continue;
      return {
        release: line.releases[index],
        line: line.name,
        lineData: line,
        newer: line.releases.slice(index + 1).filter((r) => !r.rc),
        openBackports: open.filter((o) => o.base === line.name),
      };
    }
    return null;
  };
  const previous = runtimes.find((r) => r.name !== 'main') ?? null;
  const before = point(previous?.sdkRelease?.id);
  const after = point(pr.sdkRelease?.id);
  const sdkChanges =
    before && after
      ? await commitRange(http, SDK_REPO, [before.release.sha, refOf(before.release)], [after.release.sha, refOf(after.release)])
      : null;
  const state = livePr?.merged_at ? 'merged' : livePr?.state === 'closed' ? 'closed' : 'open';
  return { status: 'found', pr, state, previous, before, after, sdkChanges };
}
