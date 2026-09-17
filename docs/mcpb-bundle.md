# The MCPB bundle

`ssh-mcp-<version>.mcpb` is attached to every GitHub release. It is a zip
containing the built server, its production dependencies and a manifest, which
Claude Desktop installs in one click. `npm run build:mcpb` produces exactly what
the release workflow produces; `scripts/build-mcpb.mjs` is the whole of it.

This file is for whoever has to change that script. The user-facing side is in
the README.

## Layout

```
manifest.json          # mcpb/manifest.json, copied verbatim
README.md  LICENSE
server/
  package.json         # pruned copy of the repo's
  build/               # tsc output, verbatim
  launch.mjs           # settings -> flags, then imports build/index.js
  flags.mjs            # the pure half of that, so it can be tested alone
  config.default.toml  # a template, as in the Docker image
  node_modules/        # npm ci --omit=dev --omit=optional --ignore-scripts
```

The nesting is not cosmetic. `src/version.ts` reads the version with
`createRequire(import.meta.url)('../package.json')`, resolved against the
*emitted* `build/version.js` — so `package.json` has to sit one directory above
`build/`. It is the same shape the `Dockerfile` assembles, for the same reason.

## Three ways to break it silently

**Dropping `"type": "module"` from the staged `package.json`.** `tsc` emits ESM
here. Without that field Node parses every file under `build/` as CommonJS and
the bundle dies on its first `import`. `build-mcpb.mjs` asserts it rather than
trusting the key list.

**Keeping `scripts`.** `prepare` runs `npm run build`, `tsc` is a devDependency
the bundle does not carry, and any `npm` invocation inside an extracted bundle
would run it and fail. The staged manifest keeps only `name`, `version`,
`description`, `type`, `dependencies`, `engines`, `license`, `author`,
`homepage` and `repository`.

**Pruning before installing.** `npm ci` validates the lockfile against
`package.json`, so installing with an already-pruned manifest fails with
`EUSAGE` — "lock file does not satisfy". The unmodified `package.json` and
`package-lock.json` go in first, the install runs, and the prune happens after.

## Why `--omit=optional`

`@napi-rs/keyring` is an optional dependency with a prebuilt native binary per
platform — twelve of them in the lockfile. Including one makes the bundle
architecture-specific; including all twelve adds tens of megabytes of dead
weight to every install. So the bundle ships neither, and `build-mcpb.mjs` walks
the staged tree and refuses any `.node` file it finds, which states the property
being bought (one artifact that runs everywhere) rather than the package being
dropped.

What this costs is `auth = "keychain"`. `src/config/credential-resolver.ts`
loads the module through a `try`/`catch`ed dynamic import, so the server starts
unaffected; a profile that asked for the keychain prints a warning and falls
back to environment variables. In this channel that is close to free: the host
already stores the extension's `sensitive` fields in the OS keychain and passes
them in as `SSH_MCP_*` variables, which is the path the resolver prefers anyway.

`--ignore-scripts` is load-bearing twice. It keeps third-party install scripts
from executing inside the release job — the reason the `mcpb` workflow job holds
no `id-token` — and it stops this repo's own `prepare` from running a `tsc` that
`--omit=dev` has just removed.

## Why there is a shim

An MCPB host substitutes `${user_config.host}` into the launch config whether or
not the user filled that field in. `src/cli.ts` tests *presence* rather than
truthiness on purpose: `nothingRequested()` reads `'host' in argv`, and its
comment names "a wrapper interpolating unset env vars" as a case that must
refuse to start. So wiring `${user_config.X}` straight into `args` would fail
the server on a blank optional field, naming a flag the user never touched.

Environment variables are the one channel where an empty value is harmless,
because `cli.ts` reads none of them. The manifest therefore puts everything in
`env`, and `launch.mjs` maps the non-empty ones onto flags before importing the
server. `flags.mjs` holds the mapping as a pure function so
`test/unit/mcpb-launch.test.ts` can pin the "blank field adds no argument"
behaviour without a built server or a subprocess.

Secrets never take that path. `SSH_MCP_PASSWORD`, `SSH_MCP_PASSPHRASE`,
`SSH_MCP_KEY` and `SSH_MCP_SUDO_PASSWORD` are read straight from the environment
by the credential resolver and must not become arguments — they would be visible
in the process list, which is why v2 removed the flags that used to accept them.

## Versioning

`mcpb/manifest.json` carries the version, and `scripts/sync-mcpb-manifest.mjs`
keeps it equal to `package.json`'s. It is wired into the `version` npm script
beside `sync-server-json.mjs`, so the rewrite lands in the "Version Packages"
pull request. `--check` fails on a stale value; `ci.yml` and `build-mcpb.mjs`
both run it, and the build refuses to pack a mismatch.

It is a sibling of `sync-server-json.mjs` rather than a second target inside it.
That script's header documents one specific failure class — the registry reports
its mistakes *after* `npm publish` has made the version immutable — and none of
it applies here.

## Release path

Three jobs in `.github/workflows/changesets.yml`, split exactly where the
`sbom`/`sbom-assets` pair is split:

| Job | Permissions | Why |
|---|---|---|
| `mcpb` | `contents: read` | Runs `npm ci` over third-party code, so it must be unable to mint anything |
| `mcpb-attest` | `id-token`, `attestations` | Pinned first-party actions only, acting on a file that already exists |
| `mcpb-assets` | `contents: write` | `gh release upload`, and nothing else |

The reason the first job holds no `id-token` is written out on the `sbom` job:
npm's trusted publisher is bound to this workflow's *filename*, so any job in
this file holding that permission can mint a token npm would accept for
`ssh-mcp`. `sbom` defends itself by installing nothing. A bundle without
`node_modules` is not a bundle, so this one cannot — hence the split, with
`--ignore-scripts` as the second layer.

`verify-release` asserts the asset is attached, by a filename that includes the
version. A release missing it is reported incomplete, and the `list_only`
dispatch input is the way to complete one without republishing.
