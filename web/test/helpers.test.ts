import { describe, expect, it } from 'vitest';
import { compareLines, parseBackportTitle } from '../src/core/backports';
import { Http, RateLimitError } from '../src/core/http';
import { crateOfFile, isBackportOf, parsePrInput } from '../src/core/lookup';
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

  it('turns an exhausted rate limit into a RateLimitError', async () => {
    const http = new Http(
      async () =>
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } }),
      { dataBase: 'data/' },
    );
    await expect(http.api('/x')).rejects.toBeInstanceOf(RateLimitError);
  });
});
