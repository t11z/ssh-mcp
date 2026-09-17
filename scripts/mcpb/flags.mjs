/**
 * Turns the extension's settings, which arrive as environment variables, into
 * the command-line flags src/cli.ts expects.
 *
 * Split out from launch.mjs so it can be tested without loading the server: the
 * one behaviour worth pinning here is that a blank field produces no argument,
 * and proving that should not require a built server, a config file or a
 * process.
 *
 * Secrets are deliberately absent from the table below. SSH_MCP_PASSWORD,
 * SSH_MCP_PASSPHRASE, SSH_MCP_KEY and SSH_MCP_SUDO_PASSWORD are read straight
 * from the environment by src/config/credential-resolver.ts and must never
 * become arguments — "Never pass passwords as CLI arguments", which is why v2
 * removed the flags that used to accept them.
 */

/** Environment variable -> the flag it fills in. Order is the flag order. */
const FLAGS = [
  ['SSH_MCP_CONFIG', '--config'],
  ['SSH_MCP_HOST', '--host'],
  ['SSH_MCP_USER', '--user'],
  ['SSH_MCP_PORT', '--port'],
  // Not SSH_MCP_KEY: that is the key path or material the credential resolver
  // reads from the environment, and it stays there. This is the same value under
  // a second name, because --key is additionally what makes buildAppConfig label
  // the quick-start profile `auth: "key"` rather than `auth: "password"`.
  ['SSH_MCP_KEY_PATH', '--key'],
  ['SSH_MCP_GROUP', '--group'],
];

export function flagsFromEnv(env) {
  const args = [];
  for (const [name, flag] of FLAGS) {
    const value = env[name];
    // Trimmed, because a host that pads an empty field with whitespace produces
    // a value that is non-empty to `if` and empty to every consumer downstream —
    // `--host=   ` reaches buildAppConfig as a truthy host and tries to resolve
    // it.
    if (typeof value !== 'string' || value.trim() === '') continue;
    args.push(`${flag}=${value.trim()}`);
  }
  return args;
}
