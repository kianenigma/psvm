import { parse as parseYaml } from 'yaml';
import { openBackports as allOpenBackports, type OpenPr } from './backports';
import { Http, SDK_REPO } from './http';
import type {
  CrateShard,
  LiveSpec,
  Locked,
  RuntimesRelease,
  SdkLine,
  SdkRelease,
  SdkReleases,
} from './types';

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  base: string;
}

/** A commit carrying the change: the original merge, or the squash-merge of a backport PR. */
export interface FixCommit {
  sha: string;
  mergedAt: string;
  /** Branch it was merged into. */
  base: string;
  /** The backport PR, if this is not the original merge. */
  backport?: { number: number; title: string; url: string };
}

export interface ContainmentCheck {
  release: SdkRelease;
  fix: FixCommit;
  contained: boolean;
  compareUrl: string;
}

export interface LineResult {
  line: SdkLine;
  /** Index into `line.releases` of the first release containing the change, or `null`. */
  firstIndex: number | null;
  /** The commit through which the line got the change. */
  via: FixCommit | null;
  /** Every compare that was made for this line (the evidence). */
  checks: ContainmentCheck[];
}

export interface TouchedCrate {
  name: string;
  bump?: string;
  /** `null` if the crate was never published from an indexed release. */
  shard: CrateShard | null;
}

export interface CrateLineVersion {
  line: string;
  /** First final (non-rc) release of the line containing the change that has the crate. */
  release: SdkRelease | null;
  version: string | null;
  /** Set when only rc tags of the line contain the change; their versions are not published. */
  rcOnly: SdkRelease | null;
}

export type LockStatus = 'contains' | 'missing' | 'unknown';

export interface LockVerdict {
  locked: Locked;
  status: LockStatus;
  /** Release the locked version originates from. */
  origin: SdkRelease | null;
  reason: string;
}

export interface RuntimesRow {
  release: RuntimesRelease;
  /** The polkadot-sdk release it is built against, and the open backports into its line. */
  sdk: { release: SdkRelease; line: string; matched: number; total: number; openBackports: OpenPr[] } | null;
  live: LiveSpec[];
  /** Crate name -> verdicts (empty if the crate is not locked by this release). */
  cells: Record<string, LockVerdict[]>;
}

export type Report =
  | { status: 'not-found'; number: number }
  | { status: 'not-merged'; pr: PrInfo }
  | {
      status: 'merged';
      pr: PrInfo;
      fixes: FixCommit[];
      /** Backport PRs that are still open, so their target lines do not have the change yet. */
      openBackports: OpenPr[];
      crates: TouchedCrate[];
      cratesSource: 'prdoc' | 'files';
      lines: LineResult[];
      crateVersions: Record<string, CrateLineVersion[]>;
      runtimes: RuntimesRow[];
      apiCalls: number;
    };

export type Progress = (message: string) => void;

interface GhPull {
  number: number;
  title: string;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
  body?: string | null;
  state: 'open' | 'closed';
  draft?: boolean;
  created_at: string;
  user?: { login: string } | null;
}

/** Parses `12408`, `#12408` or a PR URL. */
export function parsePrInput(input: string): number | null {
  const match = input.trim().match(/(?:pull\/)?#?(\d+)\/?(?:[?#].*)?$/);
  return match ? Number(match[1]) : null;
}

function toPrInfo(pull: GhPull): PrInfo {
  return {
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    merged: pull.merged,
    mergedAt: pull.merged_at,
    mergeSha: pull.merge_commit_sha,
    base: pull.base.ref,
  };
}

export async function lookupPr(http: Http, number: number, progress: Progress = () => {}): Promise<Report> {
  progress(`Fetching PR #${number}`);
  const pull = await http.api<GhPull>(`/repos/${SDK_REPO}/pulls/${number}`);
  if (!pull) return { status: 'not-found', number };
  const pr = toPrInfo(pull);
  if (!pr.merged || !pr.mergeSha || !pr.mergedAt) return { status: 'not-merged', pr };

  const original: FixCommit = { sha: pr.mergeSha, mergedAt: pr.mergedAt, base: pr.base };
  progress('Reading prdoc, searching backports, loading index');
  const [touched, { merged: backports, open: openBackports }, releases, runtimes, live, allOpen] = await Promise.all([
    touchedCrates(http, number, pr.mergeSha),
    findBackports(http, number),
    http.data<SdkReleases>('sdk-releases.json'),
    http.data<RuntimesRelease[]>('runtimes-releases.json'),
    http.data<LiveSpec[]>('live-specs.json'),
    allOpenBackports(http),
  ]);
  if (!releases || !runtimes) {
    throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  }
  const fixes = [original, ...backports];

  progress(`Checking ${releases.lines.length} release lines`);
  const lines = await Promise.all(releases.lines.map((line) => lineContainment(http, line, original, backports)));

  const crates = await Promise.all(
    touched.crates.map(async (c) => ({
      ...c,
      shard: await http.data<CrateShard>(`crates/${encodeURIComponent(c.name)}.json`),
    })),
  );

  const releaseIndex = indexReleases(lines);
  const crateVersions: Record<string, CrateLineVersion[]> = {};
  for (const c of crates) crateVersions[c.name] = lines.map((l) => crateVersionOnLine(c.shard, l, releaseIndex));

  const lineOf = new Map(lines.flatMap((l) => l.line.releases.map((r) => [r.id, l.line.name] as const)));
  const runtimesRows = runtimes.map((release) => ({
    release,
    sdk: sdkOf(release, releaseIndex, lineOf, allOpen),
    live: (live ?? []).filter((spec) => spec.releases.includes(release.name)),
    cells: Object.fromEntries(
      crates.map((c) => [
        c.name,
        (c.shard?.runtimes[release.name] ?? []).map((locked) => lockVerdict(c.shard!, locked, releaseIndex)),
      ]),
    ),
  }));

  return {
    status: 'merged',
    pr,
    fixes,
    openBackports,
    crates,
    cratesSource: touched.source,
    lines,
    crateVersions,
    runtimes: runtimesRows,
    apiCalls: http.apiCalls,
  };
}

function sdkOf(
  release: RuntimesRelease,
  releases: Map<string, IndexedRelease>,
  lineOf: Map<string, string>,
  open: OpenPr[],
): RuntimesRow['sdk'] {
  const match = release.sdkRelease;
  const sdk = match && releases.get(match.id);
  const line = match && lineOf.get(match.id);
  if (!match || !sdk || !line) return null;
  return { ...match, release: sdk.release, line, openBackports: open.filter((pr) => pr.base === line) };
}

/** Crates of the PR's prdoc at the merge commit, falling back to the crates of the changed files. */
async function touchedCrates(
  http: Http,
  number: number,
  mergeSha: string,
): Promise<{ crates: { name: string; bump?: string }[]; source: 'prdoc' | 'files' }> {
  const prdoc = await http.raw(SDK_REPO, mergeSha, `prdoc/pr_${number}.prdoc`);
  if (prdoc) {
    const doc = parseYaml(prdoc) as { crates?: { name: string; bump?: string }[] } | null;
    const crates = (doc?.crates ?? []).filter((c) => c?.name).map((c) => ({ name: c.name, bump: c.bump }));
    if (crates.length) return { crates, source: 'prdoc' };
  }

  const [files, paths] = await Promise.all([
    http.api<{ filename: string }[]>(`/repos/${SDK_REPO}/pulls/${number}/files?per_page=100`),
    http.data<Record<string, string>>('crate-paths.json'),
  ]);
  const names = new Set<string>();
  for (const { filename } of files ?? []) {
    const name = crateOfFile(filename, paths ?? {});
    if (name) names.add(name);
  }
  return { crates: [...names].sort().map((name) => ({ name })), source: 'files' };
}

/** The crate whose directory is the nearest ancestor of `file`. */
export function crateOfFile(file: string, paths: Record<string, string>): string | null {
  const parts = file.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const name = paths[parts.slice(0, i).join('/')];
    if (name) return name;
  }
  return null;
}

/**
 * Backport PRs of `number`, identified by PR metadata (never by `(#N)` in messages): merged ones
 * with their squash-merge commit, and open ones. Closed unmerged backports are dropped.
 */
async function findBackports(http: Http, number: number): Promise<{ merged: FixCommit[]; open: OpenPr[] }> {
  const query = `repo:${SDK_REPO} is:pr "Backport #${number}"`;
  const search = await http.api<{
    items: { number: number; title: string; body?: string | null; state: string; pull_request?: { merged_at: string | null } }[];
  }>(`/search/issues?q=${encodeURIComponent(query)}&per_page=100`);
  const candidates = (search?.items ?? []).filter(
    (item) =>
      (item.state === 'open' || !!item.pull_request?.merged_at) && isBackportOf(item.title, item.body ?? '', number),
  );
  const pulls = (
    await Promise.all(candidates.map((c) => http.api<GhPull>(`/repos/${SDK_REPO}/pulls/${c.number}`)))
  ).filter((p): p is GhPull => !!p);
  return {
    merged: pulls
      .filter((p) => p.merged && !!p.merge_commit_sha && !!p.merged_at)
      .map((p) => ({
        sha: p.merge_commit_sha!,
        mergedAt: p.merged_at!,
        base: p.base.ref,
        backport: { number: p.number, title: p.title, url: p.html_url },
      })),
    open: pulls
      .filter((p) => p.state === 'open')
      .map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        base: p.base.ref,
        createdAt: p.created_at,
        draft: !!p.draft,
        author: p.user?.login ?? null,
        backportOf: number,
      })),
  };
}

export function isBackportOf(title: string, body: string, number: number): boolean {
  const n = String(number);
  // `[stable2606 Backport #11910] ...` or `[stable2606] Backport #11910 ...`
  const titleRe = new RegExp(`^\\[[^\\]]*?\\]?\\s*Backport #${n}(?!\\d)`, 'i');
  const bodyRe = new RegExp(
    `backport(?:s|ed|ing)?\\s+(?:of\\s+)?(?:#|https://github\\.com/paritytech/polkadot-sdk/pull/)${n}(?!\\d)`,
    'i',
  );
  return titleRe.test(title) || bodyRe.test(body);
}

export function compareUrl(fixSha: string, releaseSha: string): string {
  return `https://github.com/${SDK_REPO}/compare/${fixSha}...${releaseSha}`;
}

/** Whether `release` contains `fix`, via the compare API (cached: both sides are immutable). */
async function contains(http: Http, fix: FixCommit, release: SdkRelease, checks: ContainmentCheck[]) {
  let contained: boolean;
  if (release.sha === fix.sha) {
    contained = true;
  } else {
    const key = `cmp:${fix.sha}:${release.sha}`;
    const cached = http.cache.get(key);
    if (cached !== null) {
      contained = cached === '1';
    } else {
      // Compared from the release, so a contained fix gives `behind` with an empty diff: the
      // other direction returns the whole diff since the fix (megabytes for older fixes).
      const compare = await http.api<{ status: string }>(
        `/repos/${SDK_REPO}/compare/${release.sha}...${fix.sha}?per_page=1`,
      );
      contained = compare?.status === 'behind' || compare?.status === 'identical';
      http.cache.set(key, contained ? '1' : '0');
    }
  }
  checks.push({ release, fix, contained, compareUrl: compareUrl(fix.sha, release.sha) });
  return contained;
}

/**
 * First release of `line` containing the change.
 *
 * Candidates: the original merge, unless the line was branched off before it (its first release
 * predates the merge), and every backport merged into the line's branch. Releases older than a
 * candidate cannot contain it; among the rest containment is monotonic, so after checking the
 * newest release a binary search finds the first one.
 */
async function lineContainment(
  http: Http,
  line: SdkLine,
  original: FixCommit,
  backports: FixCommit[],
): Promise<LineResult> {
  const releases = line.releases;
  const candidates: FixCommit[] = [];
  if (releases.length && (original.base === line.name || releases[0].date >= original.mergedAt)) {
    candidates.push(original);
  }
  candidates.push(...backports.filter((b) => b.base === line.name));

  const checks: ContainmentCheck[] = [];
  let firstIndex: number | null = null;
  let via: FixCommit | null = null;
  for (const fix of candidates) {
    let lo = releases.findIndex((r) => r.date >= fix.mergedAt);
    if (lo < 0) continue;
    let hi = releases.length - 1;
    if (!(await contains(http, fix, releases[hi], checks))) continue;
    // Lines branched off after the merge contain it from their first release on.
    if (lo < hi && (await contains(http, fix, releases[lo], checks))) hi = lo;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await contains(http, fix, releases[mid], checks)) hi = mid;
      else lo = mid + 1;
    }
    if (firstIndex === null || lo < firstIndex) {
      firstIndex = lo;
      via = fix;
    }
  }
  return { line, firstIndex, via, checks };
}

/**
 * First final release of the line that contains the change and ships the crate at a version
 * which itself contains it (its origin release does). A release can list a crate version that
 * was published before the change, if that crate was not re-published.
 */
function crateVersionOnLine(
  shard: CrateShard | null,
  result: LineResult,
  releases: Map<string, IndexedRelease>,
): CrateLineVersion {
  const empty = { line: result.line.name, release: null, version: null, rcOnly: null };
  if (!shard || result.firstIndex === null) return empty;
  const containing = result.line.releases.slice(result.firstIndex);
  const final = containing.find((r) => {
    const version = shard.sdk[r.id];
    return !r.rc && version !== undefined && releases.get(shard.origins[version])?.contained;
  });
  if (final) return { ...empty, release: final, version: shard.sdk[final.id] };
  const rc = containing.find((r) => shard.sdk[r.id] !== undefined) ?? null;
  return { ...empty, rcOnly: rc };
}

interface IndexedRelease {
  release: SdkRelease;
  contained: boolean;
}

/** Release id -> whether it contains the change (by its position on its line). */
function indexReleases(lines: LineResult[]): Map<string, IndexedRelease> {
  const index = new Map<string, IndexedRelease>();
  for (const l of lines) {
    l.line.releases.forEach((release, i) => {
      index.set(release.id, { release, contained: l.firstIndex !== null && i >= l.firstIndex });
    });
  }
  return index;
}

/**
 * Whether a runtime's locked crate version contains the change: the version's origin release
 * (where it was first published) must contain it. Never compares versions numerically.
 */
function lockVerdict(shard: CrateShard, locked: Locked, releases: Map<string, IndexedRelease>): LockVerdict {
  if (typeof locked === 'string') {
    return { locked, status: 'unknown', origin: null, reason: `git dependency (${locked})` };
  }
  const originId = shard.origins[locked.v];
  const origin = originId ? releases.get(originId) : undefined;
  if (!origin) {
    return {
      locked,
      status: 'unknown',
      origin: null,
      reason: `${shard.name} ${locked.v} is not published by any indexed release`,
    };
  }
  return {
    locked,
    status: origin.contained ? 'contains' : 'missing',
    origin: origin.release,
    reason: `${shard.name} ${locked.v} was published in ${origin.release.name}`,
  };
}
