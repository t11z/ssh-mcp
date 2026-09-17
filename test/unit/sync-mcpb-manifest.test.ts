import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { join } from 'path';

const run = promisify(execFile);

const SCRIPT = fileURLToPath(new URL('../../scripts/sync-mcpb-manifest.mjs', import.meta.url));

/**
 * scripts/sync-mcpb-manifest.mjs, the one thing keeping the bundle manifest's
 * version honest.
 *
 * It needs its own tests for the reason sync-server-json.test.ts spells out:
 * `scripts/` sits outside both tsconfigs, `sonar.sources` and the coverage
 * report, and on a healthy repo every guard in the script is false — so a guard
 * that stopped firing would look exactly like a guard that passed. The script
 * exits 0 either way.
 *
 * Driven by copying the real file into a temp tree, because it resolves its
 * inputs with `new URL('..', import.meta.url)` — a copy reads that tree's
 * fixtures. No export seam, no root argument, and no divergence between the file
 * under test and the file `npm run version` runs.
 */
async function withFixture(
  pkg: Record<string, unknown>,
  manifest: Record<string, unknown>,
  args: string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), 'ssh-mcp-mcpb-sync-'));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'mcpb'));
    await copyFile(SCRIPT, join(root, 'scripts', 'sync-mcpb-manifest.mjs'));
    await writeFile(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
    const manifestPath = join(root, 'mcpb', 'manifest.json');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await readFile(manifestPath, 'utf8');

    let result: { code: number; stdout: string; stderr: string };
    try {
      const ok = await run('node', [join(root, 'scripts', 'sync-mcpb-manifest.mjs'), ...args]);
      result = { code: 0, stdout: ok.stdout, stderr: ok.stderr };
    } catch (err: any) {
      result = { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }

    return { ...result, before, after: await readFile(manifestPath, 'utf8') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PKG = (over: Record<string, unknown> = {}) => ({
  name: 'ssh-mcp',
  version: '9.9.9',
  engines: { node: '^18.19.0 || >=20.6.0' },
  ...over,
});

const MANIFEST = (over: Record<string, unknown> = {}) => ({
  manifest_version: '0.3',
  name: 'ssh-mcp',
  version: '1.0.0',
  description: 'Policy-gated SSH.',
  compatibility: { runtimes: { node: '>=20.6.0' } },
  ...over,
});

describe('sync-mcpb-manifest — write mode', () => {
  it('writes package.json version into the manifest', async () => {
    const r = await withFixture(PKG(), MANIFEST());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.after).version).toBe('9.9.9');
  });

  // The release PR carries this file, so a reformat on every bump would be diff
  // noise a reviewer has to read past to check the one field that changed.
  it('preserves 2-space indentation, key order and the trailing newline', async () => {
    const r = await withFixture(PKG(), MANIFEST());
    expect(r.after).toBe(`${JSON.stringify(JSON.parse(r.after), null, 2)}\n`);
    expect(Object.keys(JSON.parse(r.after))).toEqual(Object.keys(MANIFEST()));
  });

  it('leaves the file untouched when it is already in sync', async () => {
    const r = await withFixture(PKG(), MANIFEST({ version: '9.9.9' }));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('already at 9.9.9');
    expect(r.after).toBe(r.before);
  });
});

describe('sync-mcpb-manifest — --check', () => {
  /**
   * ci.yml and build-mcpb.mjs both run `--check`. If it degraded to exit 0 the
   * step would always pass, which is indistinguishable from the step working —
   * so both halves are pinned: the non-zero exit, and that nothing was written.
   */
  it('fails on a stale manifest without writing to it', async () => {
    const r = await withFixture(PKG(), MANIFEST(), ['--check']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is stale');
    expect(r.after).toBe(r.before);
  });

  it('passes when the versions already agree', async () => {
    const r = await withFixture(PKG(), MANIFEST({ version: '9.9.9' }), ['--check']);
    expect(r.code).toBe(0);
    expect(r.after).toBe(r.before);
  });
});

describe('sync-mcpb-manifest — guards', () => {
  /**
   * Claude Desktop keys an installed extension on the manifest name. A rename
   * landing in one file and not the other installs a second copy beside the
   * first instead of upgrading it, and the two then share a config path.
   */
  it('refuses a manifest whose name differs from the npm package name', async () => {
    const r = await withFixture(PKG(), MANIFEST({ name: 'ssh-mcp-next' }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not match');
    expect(r.after).toBe(r.before);
  });

  /**
   * The bundle advertises a runtime floor the host uses to decide whether to
   * offer the extension at all. Asserting it is one of the clauses in
   * `engines.node` catches the bump that edits engines and forgets the manifest
   * — which is the mistake that actually happens — without pulling in a semver
   * parser this script deliberately has no dependency on.
   */
  it('refuses a runtime the package does not claim to support', async () => {
    const r = await withFixture(PKG(), MANIFEST({ compatibility: { runtimes: { node: '>=16.0.0' } } }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not one of the ranges');
    expect(r.after).toBe(r.before);
  });

  it('accepts either clause of a two-clause engines range', async () => {
    const r = await withFixture(PKG(), MANIFEST({
      version: '9.9.9',
      compatibility: { runtimes: { node: '^18.19.0' } },
    }));
    expect(r.code).toBe(0);
  });

  it('refuses a manifest that declares no runtime at all', async () => {
    const r = await withFixture(PKG(), MANIFEST({ compatibility: {} }));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no compatibility.runtimes.node');
    expect(r.after).toBe(r.before);
  });
});
