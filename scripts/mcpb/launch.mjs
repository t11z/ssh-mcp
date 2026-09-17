/**
 * Bundle entry point: applies the extension's settings, then hands over to the
 * server.
 *
 * It exists because the two sides disagree about what "unset" means. An MCPB
 * host substitutes `${user_config.host}` into the launch config whether or not
 * the user filled that field in, and src/cli.ts tests *presence* rather than
 * truthiness on purpose — `nothingRequested()` reads `'host' in argv`, and its
 * own comment names "a wrapper interpolating unset env vars" as a case that must
 * refuse to start rather than start half-configured. Wiring `${user_config.X}`
 * straight into `args` would therefore fail the server on a blank optional
 * field, naming a flag the user never touched. Environment variables are the one
 * channel where an empty value is harmless, because cli.ts reads none of them —
 * so the mapping, and the dropping, happen here instead.
 *
 * Three rules follow from this being a stdio server:
 *
 *   1. Nothing may be written to stdout. That stream is the JSON-RPC transport;
 *      one stray line and the client's parser is out of sync. Diagnostics go to
 *      stderr, which is where the server already logs.
 *   2. process.argv must be mutated *before* the import below. parseArgv() reads
 *      process.argv.slice(2) inside main(), and main() runs as a side effect of
 *      importing index.js.
 *   3. Nothing here may throw. A failure before the import is a process that
 *      exits without ever speaking the protocol, which the client reports as a
 *      transport error rather than as the configuration problem it is. Which is
 *      most of why flagsFromEnv is a pure function with its own tests.
 */
import { flagsFromEnv } from './flags.mjs';

// Spliced in ahead of the existing arguments rather than appended: anything
// already on the command line was put there by a human debugging the bundle by
// hand, and parseArgv takes the last occurrence of a repeated flag — so a
// hand-passed flag wins over the one derived from a settings field.
process.argv.splice(2, 0, ...flagsFromEnv(process.env));

await import('./build/index.js');
