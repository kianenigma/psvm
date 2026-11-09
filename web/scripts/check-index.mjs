// Sanity checks on the `psvm index` output, run before deploying so that an upstream format change (tag names,
// publication commit messages, Plan.toml/Cargo.lock layout, RPCs) fails the build instead of shipping an empty site.
//
// Usage: node scripts/check-index.mjs [data dir, default public/data]

import { existsSync, readFileSync } from 'node:fs';

const dir = process.argv[2] ?? new URL('../public/data/', import.meta.url).pathname;
const read = (file) => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const failures = [];
const check = (ok, message) => ok || failures.push(message);

const sdk = read('sdk-releases.json');
const releases = sdk.lines.flatMap((line) => line.releases);
check(sdk.lines.length >= 8, `only ${sdk.lines.length} polkadot-sdk release lines`);
check(releases.length >= 100, `only ${releases.length} polkadot-sdk release points`);
check(
  releases.some((r) => r.kind === 'untagged'),
  'no untagged crates.io publications (publication commit messages changed?)',
);
check(releases.some((r) => r.source === 'Plan.toml'), 'no release has crate versions from Plan.toml');

const versions = read('crate-version-index.json');
check(Object.keys(versions).length >= 300, `crate versions for only ${Object.keys(versions).length} crates`);
check(existsSync(`${dir}/crates/frame-support.json`), 'no crate shard for frame-support');
check(Object.keys(read('crate-paths.json')).length >= 300, 'crate-paths.json has under 300 crates');

const runtimes = read('runtimes-releases.json');
const latest = runtimes.find((r) => r.name !== 'main');
check(runtimes.some((r) => r.name === 'main'), 'no runtimes main entry');
check(runtimes.length >= 20, `only ${runtimes.length} runtimes releases`);
check(latest?.specs.length >= 5, `latest runtimes release ${latest?.name} has ${latest?.specs.length ?? 0} spec versions`);
check(latest?.sdkRelease, `latest runtimes release ${latest?.name} matches no polkadot-sdk release`);

check(Array.isArray(read('pending-releases.json')), 'pending-releases.json is not a list');
check(Array.isArray(read('missed-prs.json')), 'missed-prs.json is not a list');
// Empty if every Westend RPC failed (or --no-live): the site then omits Westend rather than not deploying.
check(Array.isArray(read('westend.json')), 'westend.json is not a list');
// Empty without a Subscan API key.
check(Array.isArray(read('westend-upgrades.json')), 'westend-upgrades.json is not a list');

// RPCs fail independently; an empty file means all of them did (or the index ran with --no-live).
check(read('live-specs.json').length > 0, 'live-specs.json is empty');

if (failures.length) {
  console.error(`Index check failed:\n${failures.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Index OK: ${sdk.lines.length} lines, ${releases.length} release points, ${runtimes.length} runtimes refs.`);
