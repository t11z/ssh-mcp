import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { TOOL_DESCRIPTIONS } from '../../src/tools/descriptions.js';

const run = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../..');
const STAGE = join(REPO_ROOT, 'dist', 'mcpb');
const BUNDLE_ENTRY = join(STAGE, 'server', 'build', 'index.js');
const BUNDLE_SHIM = join(STAGE, 'server', 'launch.mjs');

/**
 * The packed bundle, driven as a client drives it.
 *
 * This is the only test that exercises the artifact users actually install.
 * Everything else in the suite runs against the repo's own build, resolving
 * imports through a node_modules that carries devDependencies, every optional
 * dependency, and whatever npm hoisted to the top level. The bundle's tree has
 * none of that: it is `npm ci --omit=dev --omit=optional` staged beside a pruned
 * package.json. A dependency that resolves in one and not the other is invisible
 * until someone double-clicks the file.
 *
 * It runs against `dist/mcpb/`, the directory build-mcpb.mjs leaves behind,
 * rather than unzipping the .mcpb — Node has no built-in unzip and the Windows
 * runner has no `unzip` binary, so reaching into the zip would mean a dependency
 * this test does not need. The zip is a zip of exactly this directory.
 *
 * Skipped when the bundle has not been built, the same way the rest of the e2e
 * suite skips on a missing server build. `npm run build:mcpb` produces it.
 */
const bundleBuilt = existsSync(BUNDLE_ENTRY);

/**
 * Spawns from the bundle with the home directory pointed at an empty temp dir,
 * the technique packaging.e2e.test.ts uses and for the same reason: the server
 * reads its config before anything else, so without this these tests read the
 * developer's real config and assert against a machine-specific state.
 */
async function isolatedEnv(home: string): Promise<NodeJS.ProcessEnv> {
  const { SSH_MCP_DISABLE_MAIN: _omit, ...env } = process.env;
  return {
    ...(env as NodeJS.ProcessEnv),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    APPDATA: home,
  };
}

describe.skipIf(!bundleBuilt)('E2E — MCPB bundle', () => {
  /**
   * The layout constraint, asserted where it actually bites.
   *
   * src/version.ts reads the version with `require('../package.json')` resolved
   * against the emitted build/version.js. A package.json one directory too high
   * or too low is a MODULE_NOT_FOUND on the first tool call, not at startup — so
   * reading the version back out of a running bundle is the proof, and comparing
   * it to the repo's is what catches a stale staging directory.
   */
  it('reports the repo version from inside the bundle', async () => {
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    const staged = JSON.parse(await readFile(join(STAGE, 'server', 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(STAGE, 'manifest.json'), 'utf8'));

    expect(staged.version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  /**
   * tsc emits ESM here. Without `"type": "module"` on the staged package.json,
   * Node parses every file in build/ as CommonJS and the bundle dies on its
   * first `import` — and `scripts` left in place means any npm invocation inside
   * an extracted bundle runs `prepare`, which runs a tsc the bundle does not
   * carry.
   */
  it('stages a package.json that keeps the module type and drops the scripts', async () => {
    const staged = JSON.parse(await readFile(join(STAGE, 'server', 'package.json'), 'utf8'));
    expect(staged.type).toBe('module');
    expect(staged.scripts).toBeUndefined();
    expect(staged.devDependencies).toBeUndefined();
    expect(staged.optionalDependencies).toBeUndefined();
  });

  /**
   * The omission the bundle makes on purpose, stated as the property it buys
   * rather than as the package it drops: one artifact that runs everywhere.
   *
   * A .node file is compiled for the architecture that installed it, so a single
   * one turns this into a platform-specific build that installs cleanly on every
   * desktop and fails on most of them. Walking for the extension rather than
   * looking for @napi-rs also survives any other dependency acquiring native
   * code in a minor release — and npm leaves the empty @napi-rs scope directory
   * behind after skipping the optional package, so that directory proves nothing
   * either way.
   */
  it('carries no native binaries, so one bundle runs everywhere', async () => {
    const { readdir } = await import('fs/promises');
    const natives: string[] = [];
    async function walk(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else if (entry.name.endsWith('.node')) natives.push(join(dir, entry.name));
      }
    }
    await walk(join(STAGE, 'server', 'node_modules'));
    expect(natives).toEqual([]);
  });

  /**
   * A full handshake over real stdio against an empty config directory.
   *
   * Unconfigured is the state every user is in for the first few seconds after
   * installing, and the server is built for it: it completes the handshake and
   * serves tools/list so a client can introspect it, then refuses each tool call
   * with a message naming the config path. Proving the list arrives means the
   * whole import graph resolved against the bundle's own node_modules.
   */
  it('completes a handshake and lists every tool with no configuration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ssh-mcp-mcpb-'));
    const client = new Client({ name: 'mcpb-e2e', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE_ENTRY],
      env: await isolatedEnv(home) as Record<string, string>,
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_DESCRIPTIONS).sort());
    } finally {
      await client.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The shim, through the path the manifest actually launches.
   *
   * With every settings field blank it must add no arguments. `nothingRequested`
   * in src/cli.ts tests presence rather than truthiness on purpose, so a shim
   * that emitted `--host=` would fail the server here — which is exactly the
   * state a user is in the moment they install the extension and click through
   * the settings dialog without filling anything in.
   */
  it('starts through launch.mjs with every settings field blank', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ssh-mcp-mcpb-shim-'));
    const client = new Client({ name: 'mcpb-e2e', version: '1.0.0' }, { capabilities: {} });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE_SHIM],
      env: {
        ...(await isolatedEnv(home)),
        SSH_MCP_CONFIG: '',
        SSH_MCP_HOST: '',
        SSH_MCP_USER: '',
        SSH_MCP_PORT: '',
        SSH_MCP_KEY_PATH: '',
      } as Record<string, string>,
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(Object.keys(TOOL_DESCRIPTIONS).length);
    } finally {
      await client.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The same --dumpToolHashes comparison build-mcpb.mjs makes, kept here as
   * well: the script's copy guards the build, this one guards a staging
   * directory that was built once and has since gone stale against src/.
   */
  it('serves the same tool descriptions as the repo build', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ssh-mcp-mcpb-hash-'));
    try {
      const env = await isolatedEnv(home);
      const bundle = await run('node', [BUNDLE_ENTRY, '--dumpToolHashes'], { env });
      const repo = await run('node', [join(REPO_ROOT, 'build', 'index.js'), '--dumpToolHashes'], { env });
      expect(JSON.parse(bundle.stdout)).toEqual(JSON.parse(repo.stdout));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
