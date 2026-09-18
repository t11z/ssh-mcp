---
"ssh-mcp": minor
---

Ship an MCPB bundle (`ssh-mcp-<version>.mcpb`) as a release artifact, so Claude Desktop can install the server in one click instead of through a global npm install and a hand-edited `mcpServers` entry.

The bundle carries the built server and its production dependencies, and exposes seven settings fields — a config file path, the quick-start host, user, port and key path, and the SSH password, key passphrase and sudo password. Secrets are stored in the OS keychain by the host and passed in as environment variables; none of them reaches a command line. It is built by `npm run build:mcpb`, validated and packed on every pull request, and attested with SLSA build provenance before being attached to the release.

It omits the optional `@napi-rs/keyring` native module, which would otherwise make the bundle architecture-specific: profiles using `auth = "keychain"` fall back to environment variables with a warning. Installing from npm is unchanged and still offers in-process keychain reads.
