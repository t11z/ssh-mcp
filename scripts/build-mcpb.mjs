#!/usr/bin/env node
/**
 * Packs the built server into an .mcpb bundle — a zip carrying manifest.json,
 * the compiled server and its production dependencies, which Claude Desktop
 * installs in one click.
 *
 * A script rather than steps in a workflow file, for two reasons. changesets.yml
 * and ci.yml are long enough that neither should grow a multi-step shell build;
 * and a bundle that is only ever assembled by CI is a bundle nobody can debug
 * when it breaks. `npm run build:mcpb` produces here exactly what the release
 * produces there.
 *
 * Three constraints decide the layout, and all three are easy to break silently:
 *
 *   1. src/version.ts reads the version with
 *      `createRequire(import.meta.url)('../package.json')`, resolved against the
 *      *emitted* build/version.js. So package.json must sit one directory above
 *      build/ — hence server/package.json beside server/build/, the same shape
 *      the Dockerfile already assembles.
 *   2. The staged package.json must keep `"type": "module"`. tsc emits ESM here;
 *      without that field Node parses every file in build/ as CommonJS and the
 *      bundle dies on the first `import`.
 *   3. The staged package.json must *lose* `scripts`. `prepare` runs `npm run
 *      build`, tsc is a devDependency the bundle does not carry, and any npm
 *      invocation inside an extracted bundle would run it and fail.
 *
 * What the bundle omits is `@napi-rs/keyring`, an optional dependency with a
 * native binary per platform. Keeping it would mean either twelve prebuilds of
 * dead weight or a bundle per architecture; omitting it costs `auth = "keychain"`
 * profiles, which fall back to environment variables with a warning
 * (src/config/credential-resolver.ts). In this channel that is close to free:
 * the host already stores the extension's secret fields in the OS keychain and
 * passes them in as SSH_MCP_* variables, which is the path the resolver prefers
 * anyway.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (...p) => join(root, ...p);

const stage = at('dist', 'mcpb');
const serverDir = join(stage, 'server');

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

const step = (msg) => console.log(`build-mcpb: ${msg}`);
const die = (msg) => {
  console.error(`build-mcpb: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- preconditions

// The same reason test/e2e/harness.ts refuses to run against a missing build:
// packing a stale or absent one produces a bundle that proves nothing and fails
// on a user's desktop rather than here.
if (!existsSync(at('build', 'index.js'))) {
  die('build/index.js is missing — run `npm run build` first.');
}

// Refuse rather than pack a mismatch. A bundle whose manifest says 2.8.0 while
// its server says 2.9.0 installs as an extension that never offers an update,
// and nothing downstream compares the two.
try {
  run('node', [at('scripts', 'sync-mcpb-manifest.mjs'), '--check']);
} catch {
  die('mcpb/manifest.json is out of sync with package.json (see above).');
}

const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const { version } = pkg;

// --------------------------------------------------------------------- staging

// Removed and recreated every run. An incremental staging directory keeps a
// node_modules from a previous build, which is how a dependency that was dropped
// from package.json keeps shipping.
step(`staging ${stage}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(serverDir, { recursive: true });

// package.json and the lockfile go in *unmodified*, before the install. npm ci
// validates one against the other, so installing with an already-pruned manifest
// fails with EUSAGE ("lock file does not satisfy"). Install first, prune after.
cpSync(at('package.json'), join(serverDir, 'package.json'));
cpSync(at('package-lock.json'), join(serverDir, 'package-lock.json'));

// --ignore-scripts is load-bearing twice over. It keeps third-party install
// scripts from executing inside the release job — the reason the `mcpb` workflow
// job holds no id-token — and it stops this repo's own `prepare` (npm run build)
// from running tsc, which --omit=dev has just removed.
//
// --omit=optional drops @napi-rs/keyring and its twelve platform packages, plus
// ssh2's cpu-features/nan, which have a pure-JS fallback.
step('installing production dependencies (--omit=dev --omit=optional --ignore-scripts)');
run('npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts'], serverDir);

step('copying server files');
cpSync(at('build'), join(serverDir, 'build'), { recursive: true });
for (const file of ['launch.mjs', 'flags.mjs']) {
  cpSync(at('scripts', 'mcpb', file), join(serverDir, file));
}
cpSync(at('config.default.toml'), join(serverDir, 'config.default.toml'));

for (const file of ['README.md', 'LICENSE']) {
  cpSync(at(file), join(stage, file));
}
cpSync(at('mcpb', 'manifest.json'), join(stage, 'manifest.json'));

// Now prune, with the install already resolved against the real manifest.
step('pruning the staged package.json');
const staged = {};
for (const key of ['name', 'version', 'description', 'type', 'dependencies', 'engines', 'license', 'author', 'homepage', 'repository']) {
  if (pkg[key] !== undefined) staged[key] = pkg[key];
}
if (staged.type !== 'module') {
  die('package.json lost "type": "module" — every file in build/ would be parsed as CommonJS.');
}
writeFileSync(join(serverDir, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);
rmSync(join(serverDir, 'package-lock.json'), { force: true });
// Shims for executables the bundle never runs, some of which are shell scripts
// that would not survive a zip round-trip with their permission bits anyway.
rmSync(join(serverDir, 'node_modules', '.bin'), { recursive: true, force: true });

// The invariant --omit=optional is there to buy: one bundle that runs
// everywhere. A .node file is compiled for the architecture that installed it,
// so a single one turns this artifact into a platform-specific build that
// installs cleanly on every desktop and fails on most of them.
//
// Checked by walking the tree rather than by looking for @napi-rs, because the
// property is "no native code" and any dependency can acquire some in a minor
// release. npm also leaves the empty @napi-rs scope directory behind after
// skipping the optional package, so the directory's presence proves nothing
// either way.
const natives = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (entry.name.endsWith('.node')) natives.push(join(dir, entry.name));
  }
})(join(serverDir, 'node_modules'));
if (natives.length > 0) {
  die(
    `the staged tree contains ${natives.length} native binary(ies), which would make this ` +
    `bundle platform-specific: ${natives.map((p) => p.slice(serverDir.length + 1)).join(', ')}`,
  );
}

// ------------------------------------------------------------------ smoke test

// The cheapest high-value check here: --dumpToolHashes returns before
// buildAppConfig(), so it needs no configuration and no SSH server, yet reaching
// it means the entire import graph — SDK, zod, ssh2, smol-toml, OpenTelemetry —
// resolved against the bundle's own node_modules. A dependency that only
// resolves via the repo's hoisted tree fails here rather than on a desktop.
//
// It is also the only direct proof that constraint 1 above holds: version.ts
// runs on that path, and a package.json one directory too high or low is a
// MODULE_NOT_FOUND right here.
step('smoke-testing the staged bundle');
const hashesFromRepo = run('node', [at('build', 'index.js'), '--dumpToolHashes']);
const hashesFromBundle = run('node', [join(serverDir, 'build', 'index.js'), '--dumpToolHashes']);
if (hashesFromBundle !== hashesFromRepo) {
  die('the staged server reports different tool hashes than the repo build.');
}

// And the shim, end to end: with nothing set it must add no arguments, or every
// field the user left blank becomes a flag the server refuses to start on.
// test/unit/mcpb-launch.test.ts pins flagsFromEnv itself; this is the only place
// the splice and the relative import of ./flags.mjs are exercised.
const hashesViaShim = run('node', [join(serverDir, 'launch.mjs'), '--dumpToolHashes']);
if (hashesViaShim !== hashesFromRepo) {
  die('launch.mjs changed the server\'s behaviour with an empty environment.');
}
step(`  ${Object.keys(JSON.parse(hashesFromRepo)).length} tool hashes match the repo build`);

// ------------------------------------------------------------------------ pack

const mcpb = at('node_modules', '.bin', 'mcpb');
const out = at('dist', `ssh-mcp-${version}.mcpb`);

step('validating the manifest');
run(mcpb, ['validate', join(stage, 'manifest.json')]);

step('packing');
rmSync(out, { force: true });
run(mcpb, ['pack', stage, out]);

const bytes = statSync(out).size;
const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex');
const deps = Object.keys(staged.dependencies ?? {}).length;

console.log(`build-mcpb: ${out}`);
console.log(`build-mcpb:   ${(bytes / 1024 / 1024).toFixed(2)} MiB (${bytes} bytes)`);
console.log(`build-mcpb:   sha256 ${sha256}`);
console.log(`build-mcpb:   ${deps} direct dependencies, node ${staged.engines?.node ?? '?'}`);
