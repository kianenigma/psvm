import { type CommitRange, commitRange } from './backports';
import { type Http, SDK_REPO } from './http';
import type { FixCommit } from './lookup';
import type { WestendRuntime, WestendUpgrade } from './types';

export type WestendVerdict = 'contains' | 'missing' | 'unknown';

export interface WestendRow {
  runtime: WestendRuntime;
  verdict: WestendVerdict;
  reason: string;
}

/** Whether `commit` contains `sha`: compared from the commit, so containment gives `behind` and a tiny payload. */
async function commitContains(http: Http, commit: string, sha: string): Promise<boolean> {
  if (commit === sha) return true;
  const key = `cmp:${sha}:${commit}`;
  const cached = http.cache.get(key);
  if (cached !== null) return cached === '1';
  const compare = await http.api<{ status: string }>(`/repos/${SDK_REPO}/compare/${commit}...${sha}?per_page=1`);
  const contained = compare?.status === 'behind' || compare?.status === 'identical';
  http.cache.set(key, contained ? '1' : '0');
  return contained;
}

/**
 * Whether each Westend chain runs a PR: its remarked commit contains the merge or a backport. Without a remarked
 * commit, the PR is certainly missing only if every commit carrying it merged after that runtime went live.
 */
export async function westendForPr(http: Http, fixes: FixCommit[]): Promise<WestendRow[]> {
  const runtimes = (await http.data<WestendRuntime[]>('westend.json')) ?? [];
  const verdicts = new Map<string, Promise<boolean>>();
  const containsAny = (commit: string) => {
    if (!verdicts.has(commit)) {
      verdicts.set(
        commit,
        Promise.all(fixes.map((f) => commitContains(http, commit, f.sha))).then((r) => r.some(Boolean)),
      );
    }
    return verdicts.get(commit)!;
  };
  return Promise.all(
    runtimes.map(async (runtime): Promise<WestendRow> => {
      const short = runtime.commit?.slice(0, 10);
      if (runtime.commit) {
        return (await containsAny(runtime.commit))
          ? { runtime, verdict: 'contains', reason: `built from ${short}, which contains it` }
          : { runtime, verdict: 'missing', reason: `built from ${short}, which does not contain it` };
      }
      if (runtime.since && fixes.every((f) => f.mergedAt > runtime.since!)) {
        return { runtime, verdict: 'missing', reason: `live since ${runtime.since.slice(0, 10)}, before the PR merged` };
      }
      return { runtime, verdict: 'unknown', reason: 'the upgrade recorded no commit on chain' };
    }),
  );
}

export interface WestendCommit {
  sha: string;
  title: string;
  date: string;
  /** Master commits after it: what Westend does not run yet. */
  behind: CommitRange;
}

export interface WestendOverview {
  runtimes: WestendRuntime[];
  commits: WestendCommit[];
  /** The latest upgrades, newest first; empty if the index has none (it reads them from Subscan). */
  upgrades: WestendUpgrade[];
}

/** The Westend runtimes, for each remarked commit its title and the master commits since, and the latest upgrades. */
export async function westendOverview(http: Http): Promise<WestendOverview> {
  const [runtimes, upgrades] = await Promise.all([
    http.data<WestendRuntime[]>('westend.json'),
    http.data<WestendUpgrade[]>('westend-upgrades.json'),
  ]);
  if (!runtimes) throw new Error('Index files missing: run `psvm index --out web/public/data` first.');
  const shas = [...new Set(runtimes.flatMap((r) => (r.commit ? [r.commit] : [])))];
  const commits = await Promise.all(
    shas.map(async (sha): Promise<WestendCommit> => {
      const [commit, behind] = await Promise.all([
        http.api<{ commit: { message: string; committer: { date: string } } }>(`/repos/${SDK_REPO}/commits/${sha}`),
        commitRange(http, SDK_REPO, [sha, sha.slice(0, 10)], ['master', 'master']),
      ]);
      return {
        sha,
        title: commit?.commit.message.split('\n')[0] ?? '',
        date: commit?.commit.committer.date ?? '',
        behind,
      };
    }),
  );
  return { runtimes, commits, upgrades: upgrades ?? [] };
}
