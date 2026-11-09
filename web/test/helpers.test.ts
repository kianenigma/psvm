import { describe, expect, it } from 'vitest';
import {
  compareLines,
  missedPrs,
  parseBackportTitle,
  sdkReleases,
  unpublishedBackports,
  unpublishedInto,
} from '../src/core/backports';
import { BadTokenError, Http, RateLimitError } from '../src/core/http';
import { crateOfFile, type FixCommit, isBackportOf, lineState, parsePrInput } from '../src/core/lookup';
import type { SdkLine } from '../src/core/types';

describe('helpers', () => {
  it('parses PR input', () => {
    expect(parsePrInput('12408')).toBe(12408);
    expect(parsePrInput('#12408')).toBe(12408);
    expect(parsePrInput('https://github.com/paritytech/polkadot-sdk/pull/12408/files')).toBeNull();
    expect(parsePrInput('https://github.com/paritytech/polkadot-sdk/pull/12408')).toBe(12408);
    expect(parsePrInput('nope')).toBeNull();
  });

  it('parses backport titles', () => {
    expect(parseBackportTitle('[stable2609 Backport #13419] Fix eth')).toEqual({ branch: 'stable2609', of: 13419 });
    expect(parseBackportTitle('[unstable2604] Backport #12260')).toEqual({ branch: 'unstable2604', of: 12260 });
    expect(parseBackportTitle('[stable2606] Post crates release (#13556)')).toEqual({ branch: 'stable2606', of: null });
    expect(parseBackportTitle('omni-node: dev-mode fixes')).toEqual({ branch: null, of: null });
  });

  it('recognises backport PRs', () => {
    expect(isBackportOf('[stable2606 Backport #11910] XCM hardening', '', 11910)).toBe(true);
    expect(isBackportOf('[stable2606] Backport #11910', '', 11910)).toBe(true);
    expect(isBackportOf('[stable2606 Backport #119100] other', '', 11910)).toBe(false);
    expect(isBackportOf('Some fix', 'Backport of #11910 to stable2606', 11910)).toBe(true);
    expect(isBackportOf('Some fix', 'Mentions #11910', 11910)).toBe(false);
  });

  it('maps files to the nearest crate directory', () => {
    const paths = { 'substrate/frame/asset-conversion': 'pallet-asset-conversion' };
    expect(crateOfFile('substrate/frame/asset-conversion/src/lib.rs', paths)).toBe('pallet-asset-conversion');
    expect(crateOfFile('prdoc/pr_1.prdoc', paths)).toBeNull();
  });

  it('orders release lines by the YYMM in their name, stray tags last', () => {
    const line = (name: string, firstTag: string): SdkLine => ({
      name,
      hasBranch: true,
      releases: [{ id: name, name, kind: 'tag', sha: '', date: firstTag, rc: true }],
    });
    const lines = [
      line('stable2603', '2026-02-16'),
      line('stable1985', '2024-11-06'), // month 85
      line('unstable2604', '2026-05-04'),
      line('stable6210', '2026-10-20'), // 2062, tagged in 2026
      line('stable2609', '2026-09-02'),
      line('stable2606', '2026-06-02'),
    ];
    expect(lines.sort(compareLines).map((l) => l.name)).toEqual([
      'stable2609',
      'stable2606',
      'unstable2604',
      'stable2603',
      'stable6210',
      'stable1985',
    ]);
  });

  it('serves sdk-releases.json to every page with its lines sorted', async () => {
    const lines = ['stable2603', 'stable2609', 'unstable2604', 'stable2606'].map((name) => ({
      name,
      hasBranch: true,
      releases: [{ id: name, name, kind: 'tag', sha: '', date: `20${name.slice(-4, -2)}-${name.slice(-2)}-01`, rc: true }],
    }));
    const http = new Http(async () => new Response(JSON.stringify({ lines }), { headers: { 'content-type': 'application/json' } }), { dataBase: 'data/' });
    expect((await sdkReleases(http))?.lines.map((l) => l.name)).toEqual(['stable2609', 'stable2606', 'unstable2604', 'stable2603']);
  });

  // An index where stable2606-2 released #13059, stable2609 and stable2612 did not, and searches answer from `merged`
  // (backports merged since the index build) and `open`.
  const fakeIndex = (indexed: unknown[]) => {
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const line = (name: string, release: string) => ({
      name,
      hasBranch: true,
      releases: [{ id: release, name: release, kind: 'tag', sha: '', date: `20${name.slice(-4, -2)}-${name.slice(-2)}-15`, rc: false }],
    });
    const files: Record<string, unknown> = {
      'data/missed-prs.json': [
        {
          number: 13059,
          title: 'Add sufficiency method in `fungibles`',
          mergedAt: '2026-09-02T18:22:25Z',
          released: [{ line: 'stable2606', release: 'stable2606-2' }],
          missing: ['stable2609', 'stable2612'],
        },
      ],
      'data/sdk-releases.json': {
        lines: [line('stable2606', 'stable2606-2'), line('stable2609', 'polkadot-stable2609-1'), line('stable2612', 'polkadot-stable2612')],
      },
      'data/meta.json': { generatedAt: Date.parse('2026-11-09T05:07:17Z') / 1000, psvmVersion: '0.3.1' },
      'data/unpublished-backports.json': indexed,
      'data/crate-paths.json': { 'substrate/frame/support': 'frame-support', 'substrate/frame/assets': 'pallet-assets' },
    };
    // Prdocs on the branches; #13748 (a CI change) has none.
    const prdocs: Record<string, string> = {
      'stable2609/prdoc/pr_13059.prdoc': 'title: x\ncrates:\n- name: frame-support\n  bump: minor\n- name: not-a-published-crate\n  bump: patch\n',
    };
    const pr = (number: number, title: string, mergedAt: string | null) => ({
      number,
      title,
      html_url: `https://github.com/paritytech/polkadot-sdk/pull/${number}`,
      created_at: '2026-11-06T00:00:00Z',
      pull_request: { merged_at: mergedAt },
    });
    const merged = [
      pr(13755, '[stable2609 Backport #13059] Add sufficiency method in `fungibles`', '2026-11-09T09:28:02Z'),
      pr(13763, '[stable2609 Backport #13748] check-runtime-migration: skip on stable branches', '2026-11-09T10:00:00Z'),
      // Already in the index.
      pr(13900, '[stable2606 Backport #13000] Fix', '2026-11-08T10:00:00Z'),
      // Merged before stable2612's latest final release (2026-12-15), so in it.
      pr(13950, '[stable2612 Backport #13001] Other', '2026-11-08T11:00:00Z'),
    ];
    const open = [pr(13801, '[stable2612 Backport #13059] Add sufficiency method in `fungibles`', null)];
    const searches: string[] = [];
    const http = new Http(
      async (url) => {
        if (url in files) return json(files[url]);
        const raw = url.match(/^https:\/\/raw\.githubusercontent\.com\/paritytech\/polkadot-sdk\/(.+)$/);
        if (raw) return raw[1] in prdocs ? new Response(prdocs[raw[1]]) : new Response('', { status: 404 });
        const query = new URL(url).searchParams.get('q') ?? '';
        searches.push(query);
        const items = query.includes('is:merged') ? merged : open;
        return json({ total_count: items.length, items });
      },
      { dataBase: 'data/' },
    );
    return { http, searches };
  };
  const indexed = [
    {
      line: 'stable2606',
      after: 'stable2606-2',
      backports: [
        { sha: 'a', number: 13900, title: '[stable2606 Backport #13000] Fix', mergedAt: '2026-11-08T10:00:00Z', backportOf: [13000], crates: ['pallet-assets'] },
        { sha: 'b', number: 13762, title: '[stable2606 Backport #13748] CI', mergedAt: '2026-11-06T20:17:52Z', backportOf: [13748], crates: [] },
      ],
    },
  ];

  it('lists unpublished backports from the index and those merged since it was built', async () => {
    const { http, searches } = fakeIndex(indexed);
    const unpublished = await unpublishedBackports(http, await sdkReleases(http));
    const summary = [...unpublished].map(([line, list]) => [line, list.map((b) => [b.number, b.sinceIndex, b.crates])]);
    expect(summary).toEqual([
      [
        'stable2606',
        [
          [13900, false, ['pallet-assets']],
          [13762, false, []],
        ],
      ],
      [
        'stable2609',
        [
          [13763, true, []],
          // Only published crates with a bump: not `not-a-published-crate`.
          [13755, true, ['frame-support']],
        ],
      ],
    ]);
    expect(unpublished.get('stable2609')!.find((b) => b.number === 13755)!.backportOf).toEqual([13059]);
    // Backports that change no published crate need no release, so they are not counted.
    expect(unpublishedInto(unpublished, 'stable2606').map((b) => b.number)).toEqual([13900]);
    expect(unpublishedInto(unpublished, 'stable2609').map((b) => b.number)).toEqual([13755]);
    // Looks back a day before the index build, to cover backports merged while it ran.
    expect(searches).toContain('repo:paritytech/polkadot-sdk is:pr is:merged merged:>=2026-11-08 Backport in:title');
  });

  it('marks each line a missed PR misses with its unpublished or open backport', async () => {
    const [row] = await missedPrs(fakeIndex(indexed).http);
    expect(row.missing.map((m) => [m.line, m.unpublished?.number ?? null, m.open?.number ?? null])).toEqual([
      ['stable2609', 13755, null],
      ['stable2612', null, 13801],
    ]);
  });

  it('tells released, unpublished, open and missing lines apart', () => {
    const release = (id: string, rc: boolean) => ({ id, name: id, kind: 'tag' as const, sha: id, date: '2026-10-01', rc });
    const line = (name: string, releases = [release(`${name}-1`, false)]) => ({ name, hasBranch: true, releases });
    const result = (l: SdkLine, firstIndex: number | null, via: FixCommit | null = null) => ({ line: l, firstIndex, via, checks: [] });
    const backport = (base: string): FixCommit => ({
      sha: 'b',
      mergedAt: '2026-11-09T09:28:02Z',
      base,
      backport: { number: 13755, title: 'Backport', url: 'u' },
    });
    const fixes = [backport('stable2609')];
    const open = [{ number: 1, title: '', url: '', base: 'stable2612', createdAt: '', draft: false, author: null, backportOf: 13059 }];

    expect(lineState(result(line('stable2606'), 0), fixes, open).kind).toBe('released');
    // Merged into the branch after its latest release.
    expect(lineState(result(line('stable2609'), null), fixes, open)).toEqual({ kind: 'unpublished', backport: fixes[0], rc: null });
    // Only in a release candidate.
    const rcOnly = line('stable2701', [release('stable2701-rc1', true)]);
    expect(lineState(result(rcOnly, 0), fixes, open)).toMatchObject({ kind: 'unpublished', backport: null, rc: { id: 'stable2701-rc1' } });
    expect(lineState(result(line('stable2612'), null), fixes, open).kind).toBe('open');
    expect(lineState(result(line('stable2603'), null), fixes, open).kind).toBe('none');
  });

  it('reports a rejected token as such, not as a rate limit', async () => {
    const http = new Http(async () => new Response('{}', { status: 401 }), { dataBase: 'data/', token: 'bad' });
    await expect(http.api('/x')).rejects.toBeInstanceOf(BadTokenError);
  });

  it('turns an exhausted rate limit into a RateLimitError', async () => {
    const http = new Http(
      async () =>
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } }),
      { dataBase: 'data/' },
    );
    await expect(http.api('/x')).rejects.toBeInstanceOf(RateLimitError);
  });
});
