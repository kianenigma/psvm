import { Http, SDK_REPO } from './http';
import { parsePrdocCrates } from './prdoc';
import type { Meta, MissedPr, SdkLine, SdkRelease, SdkReleases, UnpublishedLine } from './types';

/** An open (unmerged) pull request into a release branch. */
export interface OpenPr {
  number: number;
  title: string;
  url: string;
  /** Target branch: from the PR itself, or parsed from the title for search results. */
  base: string | null;
  createdAt: string;
  draft: boolean;
  author: string | null;
  /** The PR this backports, if the title says so. */
  backportOf: number | null;
}

/** A backport merged into its line's branch that no final (crates.io) release of the line contains yet. */
export interface UnpublishedBackport {
  /** The backport PR. */
  number: number;
  title: string;
  url: string;
  /** The line's branch. */
  base: string;
  mergedAt: string | null;
  /** The `master` PRs it backports. */
  backportOf: number[];
  /**
   * The published crates its prdoc bumps (other than `bump: none`); `null` if unknown. Empty means it changes no
   * published crate, e.g. a CI change without a prdoc, so it needs no release: CI (`check-semver`) requires every crate
   * a PR changes to be in its prdoc.
   */
  crates: string[] | null;
  /** Merged after the index was built: found by a live search, not by the indexer. */
  sinceIndex: boolean;
}

/** Whether a merged backport changes a published crate, so that it needs a release (unknown counts as yes). */
export const publishesCrates = (backport: UnpublishedBackport) => backport.crates === null || backport.crates.length > 0;

/** The unpublished backports into `line` that change a published crate. */
export function unpublishedInto(unpublished: Unpublished, line: string): UnpublishedBackport[] {
  return (unpublished.get(line) ?? []).filter(publishesCrates);
}

/** Line name -> the line's unpublished backports, newest first. Lines without any may be absent. */
export type Unpublished = Map<string, UnpublishedBackport[]>;

interface GhIssueOrPull {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  draft?: boolean;
  user?: { login: string } | null;
  base?: { ref: string };
  /** Set on search results that are pull requests. */
  pull_request?: { merged_at: string | null };
}

/**
 * Parses backport titles: `[stable2606 Backport #12569] ...` and `[unstable2604] Backport #12260`.
 * `branch` is set for any `[stableYYMM...]`-prefixed title, `of` only for backports.
 */
export function parseBackportTitle(title: string): { branch: string | null; of: number | null } {
  const match = title.match(/^\[((?:stable|unstable)\d{4})(?:\s+Backport\s+#(\d+))?\]\s*(?:Backport\s+#(\d+))?/i);
  if (!match) return { branch: null, of: null };
  const of = match[2] ?? match[3];
  return { branch: match[1], of: of ? Number(of) : null };
}

function toOpenPr(item: GhIssueOrPull): OpenPr {
  const parsed = parseBackportTitle(item.title);
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    base: item.base?.ref ?? parsed.branch,
    createdAt: item.created_at,
    draft: !!item.draft,
    author: item.user?.login ?? null,
    backportOf: parsed.of,
  };
}

/** Up to 500 PRs with "Backport" in their title that match `qualifiers`, via one search call per 100 results. */
async function searchBackports(http: Http, qualifiers: string): Promise<GhIssueOrPull[]> {
  const query = `repo:${SDK_REPO} is:pr ${qualifiers} Backport in:title`;
  const found: GhIssueOrPull[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await http.api<{ total_count: number; items: GhIssueOrPull[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
    );
    const items = result?.items ?? [];
    found.push(...items);
    if (items.length < 100) break;
  }
  return found;
}

/** Every open backport PR of the repository. */
export async function openBackports(http: Http): Promise<OpenPr[]> {
  const prs = (await searchBackports(http, 'is:open')).map(toOpenPr).filter((pr) => pr.backportOf !== null);
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Every backport PR merged on or after `since`, a `YYYY-MM-DD` date. */
async function mergedBackportsSince(http: Http, since: string): Promise<UnpublishedBackport[]> {
  return (await searchBackports(http, `is:merged merged:>=${since}`)).flatMap((item) => {
    const { branch, of } = parseBackportTitle(item.title);
    const mergedAt = item.pull_request?.merged_at;
    if (of === null || !branch || !mergedAt) return [];
    const backport = { number: item.number, title: item.title, url: item.html_url, base: branch, mergedAt, backportOf: [of] };
    return [{ ...backport, crates: null, sinceIndex: true }];
  });
}

/**
 * The published crates the prdocs of `numbers` on `ref` bump (other than `bump: none`); `null` if a prdoc could not be
 * read. Backports carry the prdoc of the PR they backport.
 */
async function prdocCratesAt(http: Http, ref: string, numbers: number[], published: Set<string>): Promise<string[] | null> {
  try {
    const prdocs = await Promise.all(numbers.map((n) => http.raw(SDK_REPO, ref, `prdoc/pr_${n}.prdoc`)));
    const crates = prdocs.flatMap((prdoc) => (prdoc ? parsePrdocCrates(prdoc) : []));
    return [...new Set(crates.filter((c) => c.bump !== 'none' && published.has(c.name)).map((c) => c.name))].sort();
  } catch {
    return null;
  }
}

/**
 * The backports merged into each line's branch that no final release of the line contains yet: the indexer's list,
 * plus those merged since the index was built and after their line's latest final release (one search call, and their
 * prdocs from raw.githubusercontent.com). Includes backports that change no published crate; see `publishesCrates`.
 */
export async function unpublishedBackports(http: Http, releases: SdkReleases | null): Promise<Unpublished> {
  const [indexed, meta, paths] = await Promise.all([
    http.data<UnpublishedLine[]>('unpublished-backports.json'),
    http.data<Meta>('meta.json'),
    http.data<Record<string, string>>('crate-paths.json'),
  ]);
  // The index is stamped when its build ends, after it read the branches, so look back a day before that.
  const recent = meta
    ? await mergedBackportsSince(http, new Date((meta.generatedAt - 86_400) * 1000).toISOString().slice(0, 10))
    : [];
  const byLine: Unpublished = new Map(
    (indexed ?? []).map(({ line, backports }) => [
      line,
      backports.map((b) => ({
        ...b,
        url: `https://github.com/${SDK_REPO}/pull/${b.number}`,
        base: line,
        crates: b.crates ?? null,
        sinceIndex: false,
      })),
    ]),
  );
  const fresh = recent.filter((backport) => {
    const line = releases?.lines.find((l) => l.name === backport.base);
    const latest = line?.releases.filter((r) => !r.rc).at(-1);
    // Merged before the latest final release, the backport is in it (or the index would list it).
    const known = byLine.get(backport.base)?.some((b) => b.number === backport.number);
    return line && !(latest && latest.date >= backport.mergedAt!) && !known;
  });
  // The index lists the crates of what it found; read the prdocs of the rest on their branch (not rate limited).
  const published = new Set(Object.values(paths ?? {}));
  await Promise.all(
    fresh.map(async (backport) => {
      if (paths) backport.crates = await prdocCratesAt(http, backport.base, backport.backportOf, published);
    }),
  );
  for (const backport of fresh) byLine.set(backport.base, [...(byLine.get(backport.base) ?? []), backport]);
  for (const list of byLine.values()) list.sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''));
  return byLine;
}

/** The unpublished backport of `pr` into `line`, if any. */
export function unpublishedOf(unpublished: Unpublished, line: string, pr: number): UnpublishedBackport | null {
  return unpublished.get(line)?.find((b) => b.backportOf.includes(pr)) ?? null;
}

/** Every open PR into `branch` (backports and others), via the pulls API. */
export async function openPrsInto(http: Http, branch: string): Promise<OpenPr[]> {
  const pulls = await http.api<GhIssueOrPull[]>(
    `/repos/${SDK_REPO}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`,
  );
  return (pulls ?? []).map(toOpenPr);
}

export interface LineOverview {
  line: SdkLine;
  open: OpenPr[];
}

/**
 * The month a line is named after (`stable2606` -> 2026-06), as months since year 0. `null` for stray tags whose
 * `YYMM` is no month (`stable1985`) or lies more than 6 months from the line's first tag (`stable6210`).
 */
function lineMonth(line: SdkLine): number | null {
  const match = line.name.match(/(\d{2})(\d{2})$/);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return null;
  const month = (2000 + Number(match[1])) * 12 + Number(match[2]) - 1;
  const first = new Date(line.releases[0]?.date ?? 0);
  return Math.abs(month - (first.getUTCFullYear() * 12 + first.getUTCMonth())) <= 6 ? month : null;
}

/** A `stableYYMM` line whose name is a real month (not a stray tag like `stable6210`). */
export function isDatedStableLine(line: SdkLine): boolean {
  return line.name.startsWith('stable') && lineMonth(line) !== null;
}

/** The next older line of the same kind (`stable` or `unstable`) with a real `YYMM`, if any. */
function previousLineOf(lines: SdkLine[], line: SdkLine): SdkLine | null {
  const kind = (l: SdkLine) => l.name.startsWith('unstable');
  const sorted = lines.filter((l) => kind(l) === kind(line) && lineMonth(l) !== null).sort(compareLines);
  const index = sorted.indexOf(line);
  return index >= 0 ? (sorted[index + 1] ?? null) : null;
}

/** Orders lines newest first by the `YYMM` in their name, `stable` before `unstable`; stray tags last. */
export function compareLines(a: SdkLine, b: SdkLine): number {
  const [ma, mb] = [lineMonth(a), lineMonth(b)];
  if (ma === null || mb === null) {
    if (ma !== mb) return ma === null ? 1 : -1;
    return (b.releases[0]?.date ?? '').localeCompare(a.releases[0]?.date ?? '');
  }
  return mb - ma || Number(a.name.startsWith('unstable')) - Number(b.name.startsWith('unstable'));
}

/** `sdk-releases.json` with its lines sorted newest first (`compareLines`): every page reads it through this. */
export async function sdkReleases(http: Http): Promise<SdkReleases | null> {
  const releases = await http.data<SdkReleases>('sdk-releases.json');
  return releases && { ...releases, lines: [...releases.lines].sort(compareLines) };
}

/** All release lines (newest `YYMM` first) with the open backports into each. */
export async function releasesOverview(http: Http): Promise<{ lines: LineOverview[]; other: OpenPr[] }> {
  const [releases, open] = await Promise.all([sdkReleases(http), openBackports(http)]);
  if (!releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const names = new Set(releases.lines.map((l) => l.name));
  return {
    lines: releases.lines.map((line) => ({ line, open: open.filter((pr) => pr.base === line.name) })),
    other: open.filter((pr) => !pr.base || !names.has(pr.base)),
  };
}

/** A commit of a release, with the PR its squash-merge title names. */
export interface ReleaseCommit {
  sha: string;
  title: string;
  url: string;
  date: string;
  author: string | null;
  /** PR in the same repository. */
  pr: number | null;
}

/** The commits of `base...head` in `repo`: their number and the newest few. */
export interface CommitRange {
  repo: string;
  total: number;
  /** The newest commits, newest first (at most `RECENT_COMMITS`). */
  recent: ReleaseCommit[];
  /** GitHub's commit list for the whole range. */
  compareUrl: string;
}

/**
 * What a release point added on top of the previous one of its line. The first point of a line is compared with the
 * first point of the previous line of its kind (`stable2606-rc1...stable2609-rc1`), since it was cut from master.
 */
export interface ReleaseChanges extends CommitRange {
  /** The release compared against, or `null` for `master` (first point of the oldest line). */
  base: SdkRelease | null;
  /** Whether `base` is on another line. */
  previousLine: boolean;
}

export const RECENT_COMMITS = 5;

interface GhCompare {
  total_commits: number;
  commits: { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } }; author: { login: string } | null }[];
}

/**
 * Counts and lists the newest commits of `base...head`. `*Ref` name the ends in the GitHub link (tags read well), the
 * API is given immutable shas where possible. Uses the compare API: page 2 of `per_page=1` gives the total without the
 * changed-files list (GitHub only sends files on page 1), then the last page(s) of `per_page=5` give the newest
 * commits. Two or three calls; page 1 (with files) only for ranges of fewer than 10 commits.
 */
export async function commitRange(
  http: Http,
  repo: string,
  [base, baseRef]: [string, string],
  [head, headRef]: [string, string],
): Promise<CommitRange> {
  const compareUrl = `https://github.com/${repo}/compare/${baseRef}...${headRef}`;
  if (base === head) return { repo, total: 0, recent: [], compareUrl };
  const path = `/repos/${repo}/compare/${base}...${head}`;
  const total = (await http.api<GhCompare>(`${path}?per_page=1&page=2`))?.total_commits ?? 0;
  const last = Math.ceil(total / RECENT_COMMITS);
  const pages = total % RECENT_COMMITS && last > 1 ? [last - 1, last] : last ? [last] : [];
  const results = await Promise.all(pages.map((p) => http.api<GhCompare>(`${path}?per_page=${RECENT_COMMITS}&page=${p}`)));
  const recent = results
    .flatMap((r) => r?.commits ?? [])
    .slice(-RECENT_COMMITS)
    .reverse()
    .map((c): ReleaseCommit => {
      const title = c.commit.message.split('\n')[0];
      const pr = title.match(/\(#(\d+)\)\s*$/);
      return {
        sha: c.sha,
        title,
        url: c.html_url,
        date: c.commit.author.date,
        author: c.author?.login ?? c.commit.author.name,
        pr: pr ? Number(pr[1]) : null,
      };
    });
  return { repo, total, recent, compareUrl };
}

/** A ref GitHub's compare page accepts that reads well in a URL: the tag name, else the sha. */
export const refOf = (release: SdkRelease) => (release.kind === 'tag' ? release.id : release.sha);

/** Counts and lists the newest commits of `line.releases[index]` since the previous release point. */
export async function releaseChanges(
  http: Http,
  line: SdkLine,
  index: number,
  previousLine: SdkLine | null,
): Promise<ReleaseChanges> {
  const release = line.releases[index];
  const base = index > 0 ? line.releases[index - 1] : (previousLine?.releases[0] ?? null);
  const range = await commitRange(
    http,
    SDK_REPO,
    base ? [base.sha, refOf(base)] : ['master', 'master'],
    [release.sha, refOf(release)],
  );
  return { ...range, base, previousLine: index === 0 && !!base };
}

export type ReleasePage =
  | { status: 'not-found'; id: string }
  | {
      status: 'found';
      release: SdkRelease;
      line: SdkLine;
      /** Releases of the line after this one. */
      newer: SdkRelease[];
      changes: ReleaseChanges;
      backports: OpenPr[];
      /** Open PRs into the branch that are not backports. */
      others: OpenPr[];
      /** Backports merged into the branch after the line's latest final release that change a published crate. */
      unpublished: UnpublishedBackport[];
    };

/** One release point: what it added since the previous one, and the open PRs into its branch it does not contain. */
export async function releasePage(http: Http, id: string): Promise<ReleasePage> {
  const releases = await sdkReleases(http);
  if (!releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  for (const line of releases.lines) {
    // An alias sits on both the last rc and the final release (same commit): pick the final.
    const exact = line.releases.findIndex((r) => r.id === id);
    const aliased = line.releases.map((r) => !!r.aliases?.includes(id)).lastIndexOf(true);
    const index = exact >= 0 ? exact : aliased;
    if (index < 0) continue;
    const [open, changes, unpublished] = await Promise.all([
      line.hasBranch ? openPrsInto(http, line.name) : Promise.resolve([]),
      releaseChanges(http, line, index, previousLineOf(releases.lines, line)),
      unpublishedBackports(http, releases),
    ]);
    return {
      status: 'found',
      release: line.releases[index],
      line,
      newer: line.releases.slice(index + 1),
      changes,
      backports: open.filter((pr) => pr.backportOf !== null),
      others: open.filter((pr) => pr.backportOf === null),
      unpublished: unpublishedInto(unpublished, line.name),
    };
  }
  return { status: 'not-found', id };
}

export interface MissedRow {
  pr: MissedPr;
  released: SdkRelease[];
  /** Each newer line that misses it, with its backport into it: merged but not released yet, or still open. */
  missing: { line: string; latest: SdkRelease | null; unpublished: UnpublishedBackport | null; open: OpenPr | null }[];
}

/**
 * The "missed PRs" found by the indexer, with each missing line's latest release and any unpublished or open backport
 * into it. Two to ten API calls (the open and the merged backports searches).
 */
export async function missedPrs(http: Http): Promise<MissedRow[]> {
  const releasesLoaded = sdkReleases(http);
  const [missed, releases, open, unpublished] = await Promise.all([
    http.data<MissedPr[]>('missed-prs.json'),
    releasesLoaded,
    openBackports(http),
    releasesLoaded.then((r) => unpublishedBackports(http, r)),
  ]);
  if (!missed || !releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const byId = new Map(releases.lines.flatMap((l) => l.releases.map((r) => [r.id, r] as const)));
  return missed.map((pr) => ({
    pr,
    released: pr.released.flatMap((r) => byId.get(r.release) ?? []),
    missing: pr.missing.map((line) => ({
      line,
      latest: latestFinal(releases, line),
      unpublished: unpublishedOf(unpublished, line, pr.number),
      open: open.find((o) => o.backportOf === pr.number && o.base === line) ?? null,
    })),
  }));
}

/** The latest final release of `line`. */
function latestFinal(releases: SdkReleases, line: string): SdkRelease | null {
  return releases.lines.find((l) => l.name === line)?.releases.filter((r) => !r.rc).at(-1) ?? null;
}

export interface UnpublishedOverviewLine {
  line: SdkLine;
  /** The latest final release, which the backports came after. */
  latest: SdkRelease | null;
  /** Those that change a published crate. */
  backports: UnpublishedBackport[];
  /** Those that change no published crate (no prdoc, e.g. CI changes), so need no release. */
  silent: UnpublishedBackport[];
}

/** Every line with unpublished backports, newest line first. One API call (the merged backports search). */
export async function unpublishedOverview(http: Http): Promise<UnpublishedOverviewLine[]> {
  const releases = await sdkReleases(http);
  if (!releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const unpublished = await unpublishedBackports(http, releases);
  return releases.lines
    .filter((line) => unpublished.get(line.name)?.length)
    .map((line) => {
      const all = unpublished.get(line.name)!;
      return {
        line,
        latest: latestFinal(releases, line.name),
        backports: all.filter(publishesCrates),
        silent: all.filter((b) => !publishesCrates(b)),
      };
    });
}
