#!/usr/bin/env node
/**
 * Copies package.json's version into mcpb/manifest.json, the MCPB bundle manifest.
 *
 * The bundle is a zip of the built server plus this manifest, attached to each
 * GitHub release. Claude Desktop reads the manifest's `version` to decide
 * whether an installed extension is out of date, so a stale value here ships an
 * extension that reports the wrong version and never offers an update — with the
 * npm package, the registry listing and the release tag all saying something
 * else.
 *
 * Wired to the `version` npm script alongside sync-server-json.mjs, which is what
 * changesets/action runs when it opens or updates the "Version Packages" pull
 * request. It commits whatever the version command left in the working tree, so
 * the rewrite lands in that PR alongside the package.json bump — and main is
 * already correct by the time the release job builds the bundle.
 *
 * A sibling of sync-server-json.mjs rather than a second target inside it. That
 * script's header describes one specific failure class: the registry reports its
 * mistakes *after* npm publish has made the version immutable, so every guard
 * there is buying back a release that cannot be re-run. None of that is true
 * here. A stale manifest is caught by scripts/build-mcpb.mjs before anything is
 * published, and the fix is re-running one job. Folding the two together would
 * blur a comment that is doing real work and make one test cover two unrelated
 * risks.
 *
 * `--check` reports staleness instead of fixing it, for CI and for
 * build-mcpb.mjs to run before it packs anything. It reads the file rather than
 * asking git, for the reason spelled out in sync-server-json.mjs: `git diff
 * --exit-code` says nothing about an untracked file, so it passes on exactly the
 * machine where the file is missing from the index.
 *
 * What this does *not* do is validate the manifest against the MCPB schema.
 * `mcpb validate` does that, without credentials, and both ci.yml and
 * build-mcpb.mjs run it. Reimplementing a rule of that schema here would go
 * stale the first time the spec moved while still missing every other rule —
 * the same trap sync-server-json.mjs documents for server.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const checkOnly = process.argv.slice(2).includes('--check');

const root = new URL('..', import.meta.url);
const manifestFile = new URL('mcpb/manifest.json', root);

const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));

/**
 * The bundle's identity. Claude Desktop keys an installed extension on this
 * name, so a rename that lands in one file and not the other installs a second
 * copy beside the first rather than upgrading it — and the two would then fight
 * over the same config path. Cheap to compare, invisible to find later.
 */
if (manifest.name !== pkg.name) {
  console.error(
    `sync-mcpb-manifest: manifest.json name (${manifest.name ?? 'unset'}) does not match ` +
    `the npm package name (${pkg.name}). They are the same server and must carry the same name.`,
  );
  process.exit(1);
}

/**
 * The manifest advertises a runtime floor to the host, which uses it to decide
 * whether to offer the extension at all. package.json's `engines` is the floor
 * the code actually has. Advertising a lower one means the host installs the
 * bundle onto a runtime the server will not start on; advertising a higher one
 * hides it from machines that would have worked.
 *
 * Compared as strings rather than parsed: `engines.node` here is a two-clause
 * range ("^18.19.0 || >=20.6.0") whose lower bound cannot be derived without a
 * semver parser, and the whole point of this script is to have no dependencies.
 * So the manifest states its floor and this asserts the floor is one of the
 * clauses — enough to catch the bump that edits engines and forgets the
 * manifest, which is the mistake that actually happens.
 */
const engines = pkg.engines?.node ?? '';
const declared = manifest.compatibility?.runtimes?.node;
if (!declared) {
  console.error('sync-mcpb-manifest: manifest.json declares no compatibility.runtimes.node');
  process.exit(1);
}
if (!engines.split('||').some((clause) => clause.trim() === declared.trim())) {
  console.error(
    `sync-mcpb-manifest: manifest.json requires node ${declared}, which is not one of the ` +
    `ranges in package.json engines.node (${engines || 'unset'}). The bundle would advertise a ` +
    'runtime the server does not claim to support.',
  );
  process.exit(1);
}

if (manifest.version === pkg.version) {
  console.log(`sync-mcpb-manifest: mcpb/manifest.json already at ${pkg.version}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `sync-mcpb-manifest: mcpb/manifest.json is stale — manifest ${manifest.version}, but ` +
    `package.json is at ${pkg.version}. ` +
    'Run `node scripts/sync-mcpb-manifest.mjs` and commit the result.',
  );
  process.exit(1);
}

manifest.version = pkg.version;
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`sync-mcpb-manifest: mcpb/manifest.json -> ${pkg.version}`);
