import './style.css';
import {
  type CommitRange,
  type OpenPr,
  type ReleaseChanges,
  type ReleasePage,
  releasePage,
  releasesOverview,
  type LineOverview,
} from './core/backports';
import { Http, type KV, RateLimitError, RUNTIMES_REPO, SDK_REPO } from './core/http';
import {
  type CrateLineVersion,
  type LockVerdict,
  lookupPr,
  parsePrInput,
  type Report,
  type RuntimesRow,
} from './core/lookup';
import { type ChainStatus, type RuntimesOverview, type RuntimesSdk, runtimesOverview } from './core/runtimes';
import type { LiveSpec, Meta, RuntimesRelease, SdkLine, SdkRelease } from './core/types';

type Merged = Extract<Report, { status: 'merged' }>;

const TOKEN_KEY = 'psvm.token';
/** Runtimes releases shown before "Show all". */
const RUNTIMES_SHOWN = 8;

const app = document.getElementById('app')!;
const footer = document.getElementById('footer')!;
const form = document.getElementById('lookup') as HTMLFormElement;
const prInput = document.getElementById('pr-input') as HTMLInputElement;
const tokenPanel = document.getElementById('token-panel') as HTMLDetailsElement;
const tokenInput = document.getElementById('token-input') as HTMLInputElement;

/**
 * sessionStorage-backed store for the token and the compare cache; silently memory-only where storage is unavailable.
 * Not localStorage: GitHub Pages serves every project site of an account from one origin, so other sites on it could
 * read the token or forge cached results. sessionStorage is scoped to this tab.
 */
const storageKV: KV = {
  get(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // Storage full or blocked: results are only cached for this page view.
    }
  },
};

// Earlier versions kept the token and the compare cache in localStorage; remove them.
try {
  for (const key of Object.keys(localStorage)) {
    if (key === TOKEN_KEY || key.startsWith('cmp:')) localStorage.removeItem(key);
  }
} catch {
  // Storage blocked: nothing to clean up.
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (iso: string) => esc(iso.slice(0, 10));
const short = (sha: string) => esc(sha.slice(0, 12));
const link = (href: string, text: string, cls = '') =>
  `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${text}</a>`;

/** In-app page of a release point. */
const releaseHref = (release: SdkRelease) => `#/release/${encodeURIComponent(release.id)}`;
const pageLink = (href: string, text: string) => `<a href="${esc(href)}">${text}</a>`;
const releaseLink = (release: SdkRelease) => pageLink(releaseHref(release), releaseLabel(release));

function releaseUrl(release: SdkRelease): string {
  return release.kind === 'tag'
    ? `https://github.com/${SDK_REPO}/releases/tag/${release.name}`
    : `https://github.com/${SDK_REPO}/commit/${release.sha}`;
}

function releaseLabel(release: SdkRelease): string {
  if (release.kind === 'untagged') {
    return `${esc(release.name)} <span class="badge" title="${esc(release.publication ?? '')}">published, untagged</span>`;
  }
  const aliases = release.aliases?.length ? ` <span class="muted">(${release.aliases.map(esc).join(', ')})</span>` : '';
  return `${esc(release.name)}${aliases}`;
}

function crateUrl(name: string, version?: string) {
  return `https://crates.io/crates/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ''}`;
}

// --- Release lines -----------------------------------------------------------------------------

/**
 * Short label of a release point relative to its line: `rc2`, `-3`, `-1 rc1`, and the line's
 * version (e.g. `2609`) for its first final release.
 */
function stopLabel(release: SdkRelease, line: string): string {
  const rest =
    release.kind === 'untagged'
      ? release.name === 'untagged'
        ? 'publish'
        : release.name.replace(line, '')
      : release.name.replace(`polkadot-${line}`, '');
  if (!rest || rest === 'publish') return rest || line.replace(/^\D+/, '');
  return rest.replace(/^-rc/, 'rc').replace(/-rc/, ' rc');
}

interface RailOptions {
  /** First release containing the change; omitted on pages not about a change. */
  firstIndex?: number | null;
  /** Release to highlight as the one being viewed. */
  current?: string;
}

function renderRail(line: SdkLine, { firstIndex, current }: RailOptions = {}): string {
  const tracksChange = firstIndex !== undefined;
  const stops = line.releases
    .map((r, i) => {
      const inside = firstIndex != null && i >= firstIndex;
      const classes = [
        'stop',
        r.rc ? 'rc' : '',
        r.kind === 'untagged' ? 'untagged' : '',
        inside ? 'in' : '',
        i === firstIndex ? 'first' : '',
        r.id === current ? 'current' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const what = r.kind === 'untagged' ? `${r.name}, crates published without a tag (${short(r.sha)})` : r.name;
      const state = tracksChange ? `: ${inside ? 'contains the change' : 'does not contain the change'}` : '';
      const title = `${what}, ${date(r.date)}${state}`;
      return `<li class="${classes}"><a href="${esc(releaseHref(r))}" title="${esc(title)}" aria-label="${esc(title)}"${r.id === current ? ' aria-current="page"' : ''}><span class="dot"></span><span class="stop-label">${esc(stopLabel(r, line.name))}</span></a></li>`;
    })
    .join('');
  return `<ol class="rail">${stops}</ol>`;
}

const RAIL_LEGEND = `<ul class="legend" aria-label="Legend">
  <li><span class="stop"><span class="dot"></span></span>Final release</li>
  <li><span class="stop rc"><span class="dot"></span></span>Release candidate</li>
  <li><span class="stop untagged"><span class="dot"></span></span>Crates published without a git tag</li>
  <li><span class="stop in"><span class="dot"></span></span>Contains the change</li>
  <li><span class="stop in first"><span class="dot"></span></span>First release with the change</li>
</ul>`;

function renderOpenPr(pr: OpenPr, { showTarget = false, showOriginal = false } = {}): string {
  const draft = pr.draft ? ' <span class="badge">draft</span>' : '';
  const target = showTarget && pr.base ? ` into <code>${esc(pr.base)}</code>` : '';
  const original =
    showOriginal && pr.backportOf !== null ? `, backports ${pageLink(`#/pr/${pr.backportOf}`, `#${pr.backportOf}`)}` : '';
  const author = pr.author ? ` by ${esc(pr.author)}` : '';
  return `<li>${link(pr.url, `#${pr.number}`)}${draft} ${esc(pr.title)}<span class="sub">Open since ${date(pr.createdAt)}${author}${target}${original}</span></li>`;
}

function renderLines(report: Merged): string {
  const pending = (line: string) => report.openBackports.filter((pr) => pr.base === line);
  const shown = report.lines.filter((l) => l.firstIndex !== null || pending(l.line.name).length);
  const notOn = report.lines.filter((l) => l.firstIndex === null && !pending(l.line.name).length);
  const lineNames = new Set(report.lines.map((l) => l.line.name));
  const elsewhere = report.openBackports.filter((pr) => !pr.base || !lineNames.has(pr.base));

  const rows = shown
    .map((l) => {
      const open = pending(l.line.name);
      const openNote = open.length
        ? `<div class="pending"><strong>${open.length === 1 ? 'Backport pending' : `${open.length} backports pending`}</strong>: not merged into <code>${esc(l.line.name)}</code> yet, so no release of this line has ${l.firstIndex === null ? 'it' : 'it through them'}.<ul class="prs">${open.map((pr) => renderOpenPr(pr)).join('')}</ul></div>`
        : '';
      if (l.firstIndex === null) {
        return `<div class="line">
          <div class="line-name">${esc(l.line.name)}</div>
          <div>${renderRail(l.line, { firstIndex: null })}${openNote}</div>
        </div>`;
      }
      const first = l.line.releases[l.firstIndex];
      const all = l.line.releases.slice(l.firstIndex);
      const via = l.via?.backport
        ? `via backport ${link(l.via.backport.url, `#${l.via.backport.number}`)} (${link(`https://github.com/${SDK_REPO}/commit/${l.via.sha}`, `<code>${short(l.via.sha)}</code>`)})`
        : `via the original merge`;
      const evidence = l.checks
        .map(
          (c) =>
            `<li>${link(c.compareUrl, `<code>${short(c.fix.sha)}…${esc(c.release.kind === 'tag' ? c.release.name : short(c.release.sha))}</code>`)}: ${c.contained ? 'contained' : 'not contained'}</li>`,
        )
        .join('');
      return `<div class="line">
        <div class="line-name">${esc(l.line.name)}</div>
        <div>
          ${renderRail(l.line, { firstIndex: l.firstIndex })}
          <div class="line-summary">First in ${releaseLink(first)} <span class="muted">${date(first.date)}</span> <span class="via">${via}</span></div>
          <details>
            <summary>${all.length === 1 ? '1 release contains it' : `${all.length} releases contain it`}</summary>
            <ul>${all.map((r) => `<li>${releaseLink(r)} <span class="muted">${date(r.date)}</span></li>`).join('')}</ul>
            ${evidence ? `<p>Checked with the compare API:</p><ul>${evidence}</ul>` : ''}
          </details>
          ${openNote}
        </div>
      </div>`;
    })
    .join('');

  const empty = shown.length
    ? ''
    : `<p class="status">No indexed release contains this PR yet. It is merged into <code>${esc(report.pr.base)}</code> and will ship with the next release cut from it.</p>`;
  const other = elsewhere.length
    ? `<div class="pending"><strong>Open backports into other branches</strong><ul class="prs">${elsewhere.map((pr) => renderOpenPr(pr, { showTarget: true })).join('')}</ul></div>`
    : '';

  return `<section>
    <h2>Releases</h2>
    <p class="section-note">Each row is a release line. Its releases run left to right, oldest to newest; hover a release for its full name and date, or click it to see the release and the backports it is still missing. Once a release contains the change, every later release on that line does too.</p>
    ${shown.length ? RAIL_LEGEND : ''}
    ${empty}<div class="lines">${rows}</div>${other}
    ${notOn.length ? `<p class="not-on">Not on ${notOn.map((l) => `<code>${esc(l.line.name)}</code>`).join(', ')}: these lines branched off before the merge and have no backport.</p>` : ''}
  </section>`;
}

// --- Crates ------------------------------------------------------------------------------------

function renderCrateCell(name: string, v: CrateLineVersion): string {
  if (v.version && v.release) {
    return `${link(crateUrl(name, v.version), `<code>${esc(v.version)}</code>`)}<span class="sub">${releaseLink(v.release)}</span>`;
  }
  if (v.rcOnly) {
    return `<span class="muted">Only in ${pageLink(releaseHref(v.rcOnly), esc(v.rcOnly.name))}</span><span class="sub">Not published to crates.io yet</span>`;
  }
  return '<span class="muted">—</span>';
}

function renderCrates(report: Merged): string {
  const lines = report.lines.filter((l) => l.firstIndex !== null).map((l) => l.line.name);
  if (!report.crates.length) {
    return `<section><h2>Crates</h2><p class="status">This PR changes no published crate.</p></section>`;
  }
  const head = `<tr><th>Crate</th>${lines.map((l) => `<th><code>${esc(l)}</code></th>`).join('')}</tr>`;
  const rows = report.crates
    .map((c) => {
      const bump = c.bump ? `<span class="sub">${esc(c.bump)} bump</span>` : '';
      const name = c.shard ? link(crateUrl(c.name), `<code>${esc(c.name)}</code>`) : `<code>${esc(c.name)}</code>`;
      if (!c.shard) {
        return `<tr><td>${name}${bump}</td><td colspan="${lines.length || 1}" class="muted">Not published by any indexed release</td></tr>`;
      }
      const byLine = new Map(report.crateVersions[c.name].map((v) => [v.line, v]));
      return `<tr><td>${name}${bump}</td>${lines.map((l) => `<td>${renderCrateCell(c.name, byLine.get(l)!)}</td>`).join('')}</tr>`;
    })
    .join('');
  const source =
    report.cratesSource === 'prdoc'
      ? `from ${link(`https://github.com/${SDK_REPO}/blob/${report.pr.mergeSha}/prdoc/pr_${report.pr.number}.prdoc`, 'the PR’s prdoc')}`
      : 'from the files the PR changes (it has no prdoc)';
  return `<section>
    <h2>Crates</h2>
    <p class="section-note">Crates ${source}, with the first crates.io version on each line that ships the change.</p>
    <div class="table-wrap"><table>${head}${rows}</table></div>
  </section>`;
}

// --- Runtimes ----------------------------------------------------------------------------------

function renderVerdict(row: RuntimesRow, verdict: LockVerdict): string {
  const marks = { contains: '✓', missing: '✗', unknown: '?' } as const;
  const words = { contains: 'contains the change', missing: 'does not contain the change', unknown: 'unknown' } as const;
  const label = typeof verdict.locked === 'string' ? verdict.locked.slice(0, 12) : verdict.locked.v;
  const body = `<span class="mark" aria-hidden="true">${marks[verdict.status]}</span>${esc(label)}`;
  const title = `${words[verdict.status]}: ${verdict.reason}`;
  const href =
    typeof verdict.locked === 'string'
      ? `https://github.com/${RUNTIMES_REPO}/blob/${row.release.sha}/Cargo.lock`
      : `https://github.com/${RUNTIMES_REPO}/blob/${row.release.sha}/Cargo.lock#L${verdict.locked.line}`;
  return `<a class="verdict ${verdict.status}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}" aria-label="${esc(title)}">${body}</a>`;
}

const specVersion = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, '_');

/** The release's spec version, or its range if the runtimes differ; per-runtime list on hover. */
function renderSpecs(release: RuntimesRelease): string {
  if (!release.specs.length) return '<span class="muted">—</span>';
  const versions = [...new Set(release.specs.map((s) => s.specVersion))].sort((a, b) => a - b);
  const text = versions.length === 1 ? specVersion(versions[0]) : `${specVersion(versions[0])}–${specVersion(versions.at(-1)!)}`;
  const detail = release.specs.map((s) => `${s.specName} ${specVersion(s.specVersion)}`).join('\n');
  return `<code title="${esc(detail)}">${text}</code><span class="sub">${release.specs.length} runtimes</span>`;
}

/** The sdk release a runtimes release builds on, flagged by whether backports into its line are open. */
function renderSdkRelease(sdk: RuntimesRow['sdk'] | RuntimesSdk): string {
  if (!sdk) return '<span class="muted">unknown</span>';
  const { release, line, matched, total, openBackports } = sdk;
  const open = openBackports.length;
  const flag = open
    ? `<span class="flag warn" title="${open} open backport${open === 1 ? '' : 's'} into ${esc(line)}">⚠ ${open} open backport${open === 1 ? '' : 's'}</span>`
    : `<span class="flag ok" title="No open backports into ${esc(line)}">✓ no open backports</span>`;
  const label = release.kind === 'untagged' ? `${esc(release.name)} (untagged)` : esc(release.name.replace(/^polkadot-/, ''));
  return `${pageLink(releaseHref(release), label)}<span class="sub" title="${matched} of ${total} locked polkadot-sdk crates match this release">${flag}</span>`;
}

function runtimesReleaseLink(r: RuntimesRelease): string {
  return r.name === 'main'
    ? link(`https://github.com/${RUNTIMES_REPO}/tree/${r.sha}`, '<code>main</code>')
    : link(`https://github.com/${RUNTIMES_REPO}/releases/tag/${r.name}`, `<code>${esc(r.name)}</code>`);
}

function renderLive(live: LiveSpec[]): string {
  if (!live.length) return '<span class="muted">—</span>';
  const chips = live.map((s) => `<span class="chip" title="${esc(`${s.specName} ${s.specVersion}`)}">${esc(s.chain)}</span>`);
  return `<div class="chips">${chips.join('')}</div>`;
}

function renderRuntimes(report: Merged): string {
  const crates = report.crates.filter((c) => report.runtimes.some((r) => r.cells[c.name]?.length));
  if (!crates.length) {
    return `<section><h2>Fellowship runtimes</h2><p class="status">No fellowship runtimes release depends on the crates this PR changes.</p></section>`;
  }
  const head = `<tr><th>Release</th><th>Spec version</th><th>polkadot-sdk</th><th>Live on</th>${crates.map((c) => `<th><code>${esc(c.name)}</code></th>`).join('')}</tr>`;
  const rows = report.runtimes
    .map((row, i) => {
      const r = row.release;
      const name = runtimesReleaseLink(r);
      const live = renderLive(row.live);
      const cells = crates
        .map((c) => {
          const verdicts = row.cells[c.name];
          return `<td>${verdicts.length ? verdicts.map((v) => renderVerdict(row, v)).join(' ') : '<span class="muted">not used</span>'}</td>`;
        })
        .join('');
      const hidden = i >= RUNTIMES_SHOWN && !row.live.length ? ' class="hidden"' : '';
      return `<tr${hidden}><td>${name}<span class="sub">${date(r.date)}</span></td><td>${renderSpecs(r)}</td><td>${renderSdkRelease(row.sdk)}</td><td>${live}</td>${cells}</tr>`;
    })
    .join('');
  const hiddenCount = report.runtimes.filter((row, i) => i >= RUNTIMES_SHOWN && !row.live.length).length;
  return `<section>
    <h2>Fellowship runtimes</h2>
    <p class="section-note">The version of each crate locked in <code>polkadot-fellows/runtimes</code>, and whether that published version contains the change. Each cell links to its line in <code>Cargo.lock</code>. The polkadot-sdk column is the release whose crate versions match the most locked crates; click it to see the backports that release is still missing.</p>
    <div class="table-wrap"><table id="runtimes">${head}${rows}</table></div>
    ${hiddenCount ? `<button type="button" class="secondary show-more" id="show-runtimes">Show ${hiddenCount} older releases</button>` : ''}
  </section>`;
}

// --- Release pages -----------------------------------------------------------------------------

function renderOverviewLine({ line, open }: LineOverview): string {
  const latest = line.releases.at(-1);
  const summary = open.length
    ? `<div class="pending"><strong>${open.length === 1 ? '1 open backport' : `${open.length} open backports`}</strong> into <code>${esc(line.name)}</code>: no release of this line has ${open.length === 1 ? 'it' : 'them'} yet.<ul class="prs">${open.map((pr) => renderOpenPr(pr, { showOriginal: true })).join('')}</ul></div>`
    : `<p class="line-summary muted">No open backports into <code>${esc(line.name)}</code>.</p>`;
  return `<div class="line">
    <div class="line-name">${esc(line.name)}${open.length ? ` <span class="badge">${open.length} open</span>` : ''}</div>
    <div>
      ${renderRail(line)}
      ${latest ? `<p class="line-summary">Latest: ${releaseLink(latest)} <span class="muted">${date(latest.date)}</span></p>` : ''}
      ${summary}
    </div>
  </div>`;
}

function renderOverview({ lines, other }: { lines: LineOverview[]; other: OpenPr[] }): string {
  const total = lines.reduce((n, l) => n + l.open.length, 0);
  const otherBlock = other.length
    ? `<section><h2>Open backports into other branches</h2><ul class="prs">${other.map((pr) => renderOpenPr(pr, { showTarget: true, showOriginal: true })).join('')}</ul></section>`
    : '';
  return `<div class="pr-head">
      <h2>Release lines</h2>
      <div class="facts"><span>${lines.length} lines</span><span>${total} open backports</span></div>
    </div>
    <section>
      <p class="section-note">Backports are merged into a line's branch and ship with its next release. An open backport is missing from every release of its line so far. Click a release to see its details.</p>
      <div class="lines">${lines.map(renderOverviewLine).join('')}</div>
    </section>${otherBlock}`;
}

function renderChanges({ repo, base, previousLine, total, recent, compareUrl }: ReleaseChanges): string {
  const since = base
    ? `on top of ${releaseLink(base)}${previousLine ? ', the first release of the previous line' : ''}`
    : 'on top of <code>master</code>';
  if (!total) {
    return `<section><h2>No new commits</h2><p class="status">Same commit as ${base ? releaseLink(base) : '<code>master</code>'}.</p></section>`;
  }
  return `<section>
      <h2>Changes</h2>
      <p class="section-note">${total === 1 ? '1 commit' : `${total} commits`} ${since}.</p>
      ${renderCommits({ repo, total, recent, compareUrl })}
    </section>`;
}

/** The newest commits of a range, with a link to all of them on GitHub. */
function renderCommits({ repo, total, recent, compareUrl }: CommitRange): string {
  const items = recent
    .map((c) => {
      const title = esc(c.pr ? c.title.replace(/\s*\(#\d+\)\s*$/, '') : c.title);
      const ref = c.pr ? link(`https://github.com/${repo}/pull/${c.pr}`, `#${c.pr}`) : link(c.url, `<code>${short(c.sha)}</code>`);
      return `<li>${ref} ${title}<span class="sub">${date(c.date)}${c.author ? ` by ${esc(c.author)}` : ''}</span></li>`;
    })
    .join('');
  const more = total > recent.length ? `Latest ${recent.length} shown. ` : '';
  return `<ul class="prs">${items}</ul>
      <p class="section-note">${more}${link(compareUrl, `See all ${total === 1 ? 'of it' : `${total} commits`} on GitHub`)}.</p>`;
}

function renderReleasePage(page: ReleasePage): string {
  if (page.status === 'not-found') {
    return `<p class="status error">No indexed release is called <code>${esc(page.id)}</code>. Pick one from ${pageLink('#/releases', 'the release lines')}.</p>`;
  }
  const { release, line, newer, changes, backports, others } = page;
  const kind = release.kind === 'untagged' ? 'Crates published without a git tag' : release.rc ? 'Release candidate' : 'Final release';
  const position = newer.length
    ? `${newer.length} newer release${newer.length === 1 ? '' : 's'} on <code>${esc(line.name)}</code>, latest ${releaseLink(newer.at(-1)!)}`
    : `Latest release of <code>${esc(line.name)}</code>`;
  const missing = backports.length
    ? `<p class="section-note">These backports are still open, so neither this release nor any other release of <code>${esc(line.name)}</code> contains them.${newer.length ? ' Backports merged after this release may be in the newer releases; trace their original PR to check.' : ''}</p>
       <ul class="prs">${backports.map((pr) => renderOpenPr(pr, { showOriginal: true })).join('')}</ul>`
    : `<p class="status">No open backports into <code>${esc(line.name)}</code>.</p>`;
  const otherPrs = others.length
    ? `<section><h2>Other open PRs into <code>${esc(line.name)}</code></h2><ul class="prs">${others.map((pr) => renderOpenPr(pr)).join('')}</ul></section>`
    : '';
  return `<div class="pr-head">
      <h2>${link(releaseUrl(release), esc(release.name))}</h2>
      <div class="facts">
        <span>${kind}</span>
        <span>${date(release.date)}</span>
        <span>Commit ${link(`https://github.com/${SDK_REPO}/commit/${release.sha}`, `<code>${short(release.sha)}</code>`)}</span>
        ${release.aliases?.length ? `<span>Also tagged ${release.aliases.map((a) => `<code>${esc(a)}</code>`).join(', ')}</span>` : ''}
        ${release.source ? `<span>Crate versions from <code>${esc(release.source)}</code></span>` : ''}
      </div>
      ${release.publication ? `<p class="muted">${esc(release.publication)}</p>` : ''}
    </div>
    <section>
      <h2>Line <code>${esc(line.name)}</code></h2>
      <p class="section-note">${position}. ${pageLink('#/releases', 'All release lines')}.</p>
      ${renderRail(line, { current: release.id })}
    </section>
    ${renderChanges(changes)}
    <section>
      <h2>${backports.length === 1 ? '1 open backport' : `${backports.length} open backports`}</h2>
      ${missing}
    </section>${otherPrs}`;
}

// --- Fellowship runtimes page ------------------------------------------------------------------

function renderChainStatus({ spec, release, status, latestVersion }: ChainStatus, latest: string): string {
  const flag =
    status === 'current'
      ? `<span class="flag ok">✓ on ${esc(latest)}</span>`
      : status === 'behind'
        ? `<span class="flag warn" title="${esc(latest)} has ${specVersion(latestVersion!)}">⚠ upgrade to ${esc(latest)} pending</span>`
        : `<span class="muted">not in ${esc(latest)}</span>`;
  const runs = release ? `<code>${esc(release)}</code>` : '<span class="muted">no release</span>';
  return `<tr><td>${esc(spec.chain)}<span class="sub"><code>${esc(spec.specName)}</code></span></td><td><code>${specVersion(spec.specVersion)}</code></td><td>${runs}</td><td>${flag}</td></tr>`;
}

/** The sdk column of the runtimes page: also says whether the line has newer releases. */
function renderRuntimesSdk(sdk: RuntimesSdk | null): string {
  if (!sdk) return renderSdkRelease(null);
  const newer = sdk.newer.length
    ? `<span class="sub">${sdk.newer.length} newer on <code>${esc(sdk.line)}</code>, latest ${releaseLink(sdk.newer.at(-1)!)}</span>`
    : `<span class="sub">latest of <code>${esc(sdk.line)}</code></span>`;
  return renderSdkRelease(sdk) + newer;
}

function renderRuntimesPage({ latest, rows, chains, unreleased }: RuntimesOverview): string {
  if (!latest) return `<p class="status error">The index has no fellowship runtimes release.</p>`;
  const r = latest.release;
  const current = chains.filter((c) => c.status === 'current').length;
  const generated = meta ? ` as of ${new Date(meta.generatedAt * 1000).toLocaleString()}` : '';
  const chainTable = chains.length
    ? `<div class="table-wrap"><table><tr><th>Chain</th><th>Spec version</th><th>Release</th><th>Status</th></tr>${chains.map((c) => renderChainStatus(c, r.name)).join('')}</table></div>`
    : `<p class="status">No live chain data in the index (it was built with <code>--no-live</code>, or every RPC failed).</p>`;
  const changes = !unreleased
    ? ''
    : unreleased.total
      ? `<p class="section-note">${unreleased.total === 1 ? '1 commit' : `${unreleased.total} commits`} on <code>main</code> since ${runtimesReleaseLink(r)}.</p>${renderCommits(unreleased)}`
      : `<p class="status"><code>main</code> has nothing since ${runtimesReleaseLink(r)}.</p>`;
  const releaseRows = rows
    .map((row, i) => {
      const hidden = i >= RUNTIMES_SHOWN && !row.live.length ? ' class="hidden"' : '';
      return `<tr${hidden}><td>${runtimesReleaseLink(row.release)}<span class="sub">${date(row.release.date)}</span></td><td>${renderSpecs(row.release)}</td><td>${renderRuntimesSdk(row.sdk)}</td><td>${renderLive(row.live)}</td></tr>`;
    })
    .join('');
  const hiddenCount = rows.filter((row, i) => i >= RUNTIMES_SHOWN && !row.live.length).length;
  return `<div class="pr-head">
      <h2>Fellowship runtimes</h2>
      <div class="facts">
        <span>Latest release ${runtimesReleaseLink(r)} ${date(r.date)}</span>
        <span>Spec version ${renderSpecs(r).replace(/<span class="sub">.*<\/span>/, '')}</span>
        ${chains.length ? `<span>${current} of ${chains.length} chains on it</span>` : ''}
      </div>
    </div>
    <section>
      <h2>Live chains</h2>
      <p class="section-note">The runtime each chain runs${esc(generated)}, read over RPC when the index was built, against ${runtimesReleaseLink(r)}.</p>
      ${chainTable}
    </section>
    <section>
      <h2>Unreleased on <code>main</code></h2>
      ${changes}
    </section>
    <section>
      <h2>Releases</h2>
      <p class="section-note">The polkadot-sdk column is the release whose crate versions match the most crates locked in each release's <code>Cargo.lock</code>; click it to see the backports that release is missing.</p>
      <div class="table-wrap"><table id="runtimes"><tr><th>Release</th><th>Spec version</th><th>polkadot-sdk</th><th>Live on</th></tr>${releaseRows}</table></div>
      ${hiddenCount ? `<button type="button" class="secondary show-more" id="show-runtimes">Show ${hiddenCount} older releases</button>` : ''}
    </section>`;
}

// --- Page --------------------------------------------------------------------------------------

function renderReport(report: Report): string {
  if (report.status === 'not-found') {
    return `<p class="status error">PR #${report.number} does not exist in <code>${SDK_REPO}</code>. Check the number and try again.</p>`;
  }
  const pr = report.pr;
  const head = `<div class="pr-head">
    <h2>${link(pr.url, esc(pr.title))}</h2>
    <div class="facts">
      <span>#${pr.number}</span>
      <span>Base <code>${esc(pr.base)}</code></span>
      ${pr.mergedAt ? `<span>Merged ${date(pr.mergedAt)}</span>` : ''}
      ${pr.mergeSha && pr.merged ? `<span>Merge commit ${link(`https://github.com/${SDK_REPO}/commit/${pr.mergeSha}`, `<code>${short(pr.mergeSha)}</code>`)}</span>` : ''}
    </div>
  </div>`;
  if (report.status === 'not-merged') {
    return `${head}<p class="status">This PR is not merged, so no release contains it yet.</p>`;
  }
  return `${head}${renderLines(report)}${renderCrates(report)}${renderRuntimes(report)}`;
}

function status(message: string, error = false) {
  app.innerHTML = `<p class="status${error ? ' error' : ''}">${message}</p>`;
}

let current = 0;

/** Loads and renders one page, ignoring results of pages navigated away from. */
async function show<T>(loading: string, load: (http: Http, progress: (m: string) => void) => Promise<T>, render: (data: T) => string, title: string) {
  const token = storageKV.get(TOKEN_KEY) ?? undefined;
  const http = new Http((url, init) => fetch(url, init), { token, dataBase: 'data/', cache: storageKV });
  const id = ++current;
  status(esc(loading));
  try {
    const data = await load(http, (m) => id === current && status(esc(m) + '…'));
    if (id !== current) return;
    app.innerHTML = render(data);
    document.title = title;
    document.getElementById('show-runtimes')?.addEventListener('click', (e) => {
      document.querySelectorAll('#runtimes tr.hidden').forEach((tr) => tr.classList.remove('hidden'));
      (e.target as HTMLElement).remove();
    });
    const remaining = http.rateRemaining === null ? '' : `, ${http.rateRemaining} left this hour`;
    footer.dataset.calls = `${http.apiCalls} GitHub API calls${remaining}`;
    renderFooter();
  } catch (e) {
    if (id !== current) return;
    if (e instanceof RateLimitError) {
      tokenPanel.open = true;
      status(esc(e.message), true);
    } else {
      status(`Lookup failed: ${esc(e instanceof Error ? e.message : String(e))}`, true);
    }
  }
}

function run(number: number) {
  prInput.value = String(number);
  void show(`Tracing #${number}…`, (http, progress) => lookupPr(http, number, progress), renderReport, `#${number} · Where is my PR?`);
}

let meta: Meta | null = null;
function renderFooter() {
  const indexed = meta ? `Index built ${new Date(meta.generatedAt * 1000).toLocaleString()} by psvm ${esc(meta.psvmVersion)}.` : 'Index not found.';
  const calls = footer.dataset.calls ? ` This page used ${esc(footer.dataset.calls)}.` : '';
  footer.innerHTML = `<p>${indexed}${calls} Source: ${link('https://github.com/kianenigma/psvm', 'kianenigma/psvm')}.</p>`;
}

function route() {
  const hash = location.hash;
  document.querySelectorAll<HTMLAnchorElement>('.nav a').forEach((a) => {
    const href = a.getAttribute('href')!;
    const active =
      href === '#/releases' ? hash.startsWith('#/release') : href === '#/runtimes' ? hash === href : !/^#\/(release|runtimes)/.test(hash);
    a.toggleAttribute('aria-current', active);
  });
  document.body.dataset.page = hash === '' || hash === '#/' ? 'home' : 'other';
  // The PR field only belongs to the trace pages; the other pages keep just the token panel.
  form.hidden = /^#\/(release|runtimes)/.test(hash);
  const pr = hash.match(/^#\/pr\/(\d+)/);
  const release = hash.match(/^#\/release\/(.+)$/);
  if (pr) run(Number(pr[1]));
  else if (hash === '#/runtimes')
    void show('Loading fellowship runtimes…', (http) => runtimesOverview(http), renderRuntimesPage, 'Fellowship runtimes · Where is my PR?');
  else if (hash === '#/releases')
    void show('Loading release lines and open backports…', (http) => releasesOverview(http), renderOverview, 'Release lines · Where is my PR?');
  else if (release) {
    let id: string;
    try {
      id = decodeURIComponent(release[1]);
    } catch {
      id = release[1]; // Malformed escape (`%E0`): look it up as typed, which finds nothing.
    }
    void show(`Loading ${id}…`, (http) => releasePage(http, id), renderReleasePage, `${id} · Where is my PR?`);
  } else
    app.innerHTML = `<p class="status">Enter a PR number, for example <a href="#/pr/12408">#12408</a> or <a href="#/pr/11910">#11910</a>, or browse <a href="#/releases">the release lines and their open backports</a>.</p>`;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const number = parsePrInput(prInput.value);
  if (number === null) {
    status('Enter a PR number such as 12408, or a link to the PR.', true);
    return;
  }
  const hash = `#/pr/${number}`;
  if (location.hash === hash) run(number);
  else location.hash = hash;
});

tokenInput.value = storageKV.get(TOKEN_KEY) ?? '';
document.getElementById('token-save')!.addEventListener('click', () => {
  storageKV.set(TOKEN_KEY, tokenInput.value.trim());
  tokenPanel.open = false;
  route();
});

// Theme switch: `public/theme.js` applies the saved choice before paint; this keeps it and the buttons in sync.
// localStorage (not sessionStorage) is fine here: a display preference, nothing to leak.
const THEME_KEY = 'psvm.theme';
function setTheme(choice: string) {
  if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  const current = document.documentElement.dataset.theme ?? 'system';
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === current));
  });
  try {
    if (current === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, current);
  } catch {
    // Storage blocked: the choice lasts for this page view.
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
  b.addEventListener('click', () => setTheme(b.dataset.themeChoice!));
});
setTheme(document.documentElement.dataset.theme ?? 'system');

window.addEventListener('hashchange', route);
fetch('data/meta.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((m: Meta | null) => {
    meta = m;
    renderFooter();
  })
  .catch(() => renderFooter());
route();
