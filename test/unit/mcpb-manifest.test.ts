import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { TOOL_DESCRIPTIONS } from '../../src/tools/descriptions.js';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8'));

const manifest = read('../../mcpb/manifest.json');
const pkg = read('../../package.json');

/**
 * Assertions on the real mcpb/manifest.json, not on a fixture.
 *
 * The manifest is data the bundle carries and nothing in the build validates
 * against the code: `mcpb validate` checks it against the MCPB schema, which
 * knows nothing about this server's tools or which environment variables it
 * reads. So every claim the manifest makes about ssh-mcp specifically — the tool
 * list, the settings-to-environment wiring — is unchecked unless it is checked
 * here, and a mistake in it surfaces as an extension that installs cleanly and
 * then does the wrong thing. This file fails on the pull request that writes it
 * instead.
 */
describe('mcpb/manifest.json', () => {
  it('declares the version package.json is at', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('is the same server as the npm package', () => {
    expect(manifest.name).toBe(pkg.name);
  });

  /**
   * The host shows this list before installing, and `tools_generated: false`
   * promises it is complete. A tool added to the server without a line here is
   * invisible in that preview; a tool removed leaves a line advertising
   * something that no longer answers.
   */
  it('lists exactly the tools the server registers', () => {
    const declared = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(declared).toEqual(Object.keys(TOOL_DESCRIPTIONS).sort());
    expect(manifest.tools_generated).toBe(false);
  });

  it('gives every declared tool a description', () => {
    for (const tool of manifest.tools) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
    }
  });

  /**
   * `${user_config.X}` naming a field that does not exist expands to nothing,
   * silently — the variable arrives empty and the setting the user filled in is
   * simply ignored. Nothing else would notice.
   */
  it('only substitutes user_config fields that exist', () => {
    const declared = new Set(Object.keys(manifest.user_config));
    const referenced = JSON.stringify(manifest.server.mcp_config)
      .match(/\$\{user_config\.([A-Za-z0-9_]+)\}/g) ?? [];
    for (const ref of referenced) {
      const key = ref.slice('${user_config.'.length, -1);
      expect(declared, `${ref} is not a declared user_config field`).toContain(key);
    }
    expect(referenced.length).toBeGreaterThan(0);
  });

  /**
   * Every secret field must land in a variable src/config/credential-resolver.ts
   * actually reads. A typo here produces a field that looks configured in the
   * UI, is stored in the OS keychain, and never reaches the server — which
   * presents to the user as an authentication failure with no cause.
   */
  it('maps secrets onto environment variables the resolver reads', () => {
    const resolver = readFileSync(
      fileURLToPath(new URL('../../src/config/credential-resolver.ts', import.meta.url)),
      'utf8',
    );
    const env = manifest.server.mcp_config.env as Record<string, string>;

    for (const [name, field] of Object.entries(manifest.user_config as Record<string, any>)) {
      if (!field.sensitive) continue;
      const target = Object.entries(env).find(([, v]) => v === `\${user_config.${name}}`)?.[0];
      expect(target, `sensitive field ${name} is not passed to the server`).toBeTruthy();
      expect(resolver, `${target} is not read by credential-resolver.ts`).toContain(target!);
    }
  });

  /**
   * "Never pass passwords as CLI arguments" — they are visible in the process
   * list, which is why v2 removed the flags that used to take them. The bundle
   * must not reintroduce that through the launch config.
   */
  it('passes no user_config value as a command-line argument', () => {
    expect(JSON.stringify(manifest.server.mcp_config.args)).not.toContain('user_config');
  });

  /**
   * `type: "node"` means the host supplies the runtime and runs the entry as an
   * argument to it — the shebang and the executable bit in build/ are not in
   * play. The entry must also be the file build-mcpb.mjs actually stages.
   */
  it('launches the staged shim through the host runtime', () => {
    expect(manifest.server.type).toBe('node');
    expect(manifest.server.mcp_config.command).toBe('node');
    expect(manifest.server.entry_point).toBe('server/launch.mjs');
    expect(manifest.server.mcp_config.args[0]).toBe('${__dirname}/server/launch.mjs');
  });

  it('requires a node version package.json engines allows', () => {
    const clauses = (pkg.engines.node as string).split('||').map((c: string) => c.trim());
    expect(clauses).toContain(manifest.compatibility.runtimes.node);
  });
});
