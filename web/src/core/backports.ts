import { Http, SDK_REPO } from './http';
import type { SdkLine, SdkRelease, SdkReleases } from './types';

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

interface GhIssueOrPull {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  draft?: boolean;
  user?: { login: string } | null;
  base?: { ref: string };
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

/** Every open backport PR of the repository, via one search call per 100 results. */
export async function openBackports(http: Http): Promise<OpenPr[]> {
  const query = `repo:${SDK_REPO} is:pr is:open Backport in:title`;
  const prs: OpenPr[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await http.api<{ total_count: number; items: GhIssueOrPull[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=100&page=${page}`,
    );
    const items = result?.items ?? [];
    prs.push(...items.map(toOpenPr).filter((pr) => pr.backportOf !== null));
    if (items.length < 100) break;
  }
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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

/** All release lines (newest `YYMM` first) with the open backports into each. */
export async function releasesOverview(http: Http): Promise<{ lines: LineOverview[]; other: OpenPr[] }> {
  const [releases, open] = await Promise.all([http.data<SdkReleases>('sdk-releases.json'), openBackports(http)]);
  if (!releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const names = new Set(releases.lines.map((l) => l.name));
  const lines = [...releases.lines].sort(compareLines);
  return {
    lines: lines.map((line) => ({ line, open: open.filter((pr) => pr.base === line.name) })),
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
const refOf = (release: SdkRelease) => (release.kind === 'tag' ? release.id : release.sha);

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
    };

/** One release point: what it added since the previous one, and the open PRs into its branch it does not contain. */
export async function releasePage(http: Http, id: string): Promise<ReleasePage> {
  const releases = await http.data<SdkReleases>('sdk-releases.json');
  if (!releases) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  for (const line of releases.lines) {
    // An alias sits on both the last rc and the final release (same commit): pick the final.
    const exact = line.releases.findIndex((r) => r.id === id);
    const aliased = line.releases.map((r) => !!r.aliases?.includes(id)).lastIndexOf(true);
    const index = exact >= 0 ? exact : aliased;
    if (index < 0) continue;
    const [open, changes] = await Promise.all([
      line.hasBranch ? openPrsInto(http, line.name) : Promise.resolve([]),
      releaseChanges(http, line, index, previousLineOf(releases.lines, line)),
    ]);
    return {
      status: 'found',
      release: line.releases[index],
      line,
      newer: line.releases.slice(index + 1),
      changes,
      backports: open.filter((pr) => pr.backportOf !== null),
      others: open.filter((pr) => pr.backportOf === null),
    };
  }
  return { status: 'not-found', id };
}
