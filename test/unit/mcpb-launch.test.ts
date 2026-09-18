import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs with no type declarations; it ships in the
// bundle rather than being compiled, so there is nothing for tsc to emit.
import { flagsFromEnv } from '../../scripts/mcpb/flags.mjs';

/**
 * scripts/mcpb/flags.mjs — the settings-to-flags half of the bundle's launcher.
 *
 * It exists for one behaviour, and that behaviour is what these tests pin: a
 * blank settings field must produce no argument. An MCPB host substitutes
 * `${user_config.host}` whether or not the user filled the field in, and
 * `nothingRequested()` in src/cli.ts tests presence rather than truthiness on
 * purpose — its comment names "a wrapper interpolating unset env vars" as a case
 * that must refuse to start. So a shim that emitted `--host=` would fail the
 * server on a field nobody touched, with a message about a flag nobody typed.
 *
 * Split from launch.mjs precisely so this file needs no built server, no config
 * and no subprocess to prove it.
 */
describe('mcpb launch shim', () => {
  it('adds nothing when no settings are filled in', () => {
    expect(flagsFromEnv({})).toEqual([]);
  });

  /**
   * Empty and whitespace-only are the same case. A host that pads a blank field
   * produces a value that is non-empty to `if` and empty to everything
   * downstream, which is the worse of the two failures: `--host=   ` reaches
   * buildAppConfig as a truthy host and tries to resolve it.
   */
  it('drops empty and whitespace-only values', () => {
    expect(flagsFromEnv({
      SSH_MCP_CONFIG: '',
      SSH_MCP_HOST: '   ',
      SSH_MCP_USER: '\t\n',
      SSH_MCP_PORT: '',
    })).toEqual([]);
  });

  it('maps each variable onto its flag', () => {
    expect(flagsFromEnv({
      SSH_MCP_CONFIG: '/etc/ssh-mcp.toml',
      SSH_MCP_HOST: 'db01.example.com',
      SSH_MCP_USER: 'deploy',
      SSH_MCP_PORT: '2222',
      SSH_MCP_KEY_PATH: '/keys/id_ed25519',
      SSH_MCP_GROUP: 'prod',
    })).toEqual([
      '--config=/etc/ssh-mcp.toml',
      '--host=db01.example.com',
      '--user=deploy',
      '--port=2222',
      '--key=/keys/id_ed25519',
      '--group=prod',
    ]);
  });

  it('passes through a partially filled configuration', () => {
    expect(flagsFromEnv({ SSH_MCP_HOST: 'h', SSH_MCP_USER: 'u' }))
      .toEqual(['--host=h', '--user=u']);
  });

  /**
   * SSH_MCP_KEY is the variable src/config/credential-resolver.ts reads for key
   * material or a key path, and it must stay in the environment. The manifest
   * sets both from one field; only SSH_MCP_KEY_PATH becomes a flag, because
   * --key is additionally what makes buildAppConfig label the quick-start
   * profile `auth: "key"` instead of `auth: "password"`.
   */
  it('never turns a credential variable into an argument', () => {
    const secrets = {
      SSH_MCP_KEY: '/keys/id_ed25519',
      SSH_MCP_PASSWORD: 'hunter2',
      SSH_MCP_PASSPHRASE: 'hunter2',
      SSH_MCP_SUDO_PASSWORD: 'hunter2',
    };
    expect(flagsFromEnv(secrets)).toEqual([]);
    expect(flagsFromEnv({ ...secrets, SSH_MCP_HOST: 'h' }).join(' ')).not.toContain('hunter2');
  });

  it('ignores values that are not strings', () => {
    expect(flagsFromEnv({ SSH_MCP_HOST: undefined, SSH_MCP_USER: null, SSH_MCP_PORT: 22 } as any))
      .toEqual([]);
  });
});
