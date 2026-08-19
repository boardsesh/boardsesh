/// <reference types="node" />

/**
 * Shared helpers for invoking the self-hosted OTA CLI (`eoas`, the expo-open-ota
 * client) via `bunx`. Used by both the production publish (scripts/mobile-publish.ts)
 * and the rollback runbook (scripts/mobile-ota-rollback.ts). Kept dependency-free
 * so the lib layer never imports a sibling orchestrator script.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { join, delimiter } from 'node:path';

// The eoas CLI spec passed to `bunx`. Pinned, not `@latest`: V3 routes are
// app-scoped, so a v2 CLI 404s against our self-hosted server.
//
// The rule here used to be "the CLI must match the deployed server EXACTLY".
// That was our own convention, not a protocol requirement — neither build
// exchanges a version (no cliVersion/serverVersion handshake exists in either
// dist). The real rule is: **the CLI may lead the server, never trail it.**
// 3.1.2 was checked wire-compatible against the still-3.0.5 server before this
// bump — the three routes the publish path uses
// (`/{appId}/requestUploadUrl/{branch}`, `/uploadLocalFile`,
// `/markUpdateAsUploaded/{branch}`) are unchanged, and the
// `markUpdateAsUploaded` block is byte-identical between the two builds.
//
// Why 3.1.2 (released 2026-08-19): it carries the two upstream fixes for the
// Tigris `SlowDown` throttling in #3620. `fetchWithRetries` now retries 429/5xx
// and honours `Retry-After` (≤3.1.1 retried network errors only, so a single 503
// mid-upload called `process.exit(1)` and killed the whole publish), and
// `publish` gained `--upload-rate` to cap what was an unbounded `Promise.all`
// over every asset in the export.
//
// Two things still wait on the Railway image moving to
// `ghcr.io/mercuretechnologies/xprem:v3.1.2` (the project renamed
// expo-open-ota → xprem; the old image name is still published):
//   * server-side reuse of the previous update's assets (xprem #165) — the half
//     that drops a repeat publish from ~380 uploads to a handful; and
//   * `vp run mobile:ota-rollback -- --mode republish`, whose route shapes moved
//     between 3.1.1 and 3.1.2 (server-side back-compat landed in xprem #168).
//     `--mode embedded`, the mode the rollback runbook actually uses, is
//     unaffected.
//
// Single source of truth: imported by mobile-publish.ts, mobile-ota-rollback.ts,
// mobile-ota-setup.ts, and asserted by the rollback + version-parity tests so a
// stale copy can't creep back in per-file.
export const EOAS_PACKAGE_SPEC = 'eoas@3.1.2';

// Asset-upload starts per second for a self-hosted publish, passed as
// `eoas publish --upload-rate`. The CLI default is 10; we run 5 because the
// limiter is PER PROCESS while our preview publishes are per-PR concurrent —
// 11 simultaneous publish jobs were measured on 2026-08-19, which at the default
// would aim ~110 upload starts/sec at the one `boardsesh-ota-v3` bucket. At 5
// that peak is ~55/sec, and a lone publish still starts all 380 assets of a full
// bundle inside ~76 seconds.
export const SELF_HOSTED_UPLOAD_RATE_PER_SECOND = 5;

// vp (Vite+) prepends its own bun shim directory to PATH, and that shim's `bunx`
// is a `/bin/sh` wrapper that forwards to `bun` WITHOUT switching to x-mode — so
// `bunx <pkg>` runs as `bun <pkg>` (script mode) and dies with
// `Script not found "<pkg>"`. The real bunx (from bun / setup-bun) is a binary
// symlink, never a `#!` script. Under `vp run` this breaks BOTH the eoas/eas
// invocation AND the `expo export` eoas spawns via --packageRunner bunx (it
// inherits this env). Drop any PATH entry whose `bunx` is a `#!` script shim so a
// working bunx wins — fixes CI (vp on PATH) and local `vp run` invocations.
export function bunxIsScriptShim(dir: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, 'bunx'), 'r');
    const head = Buffer.alloc(2);
    readSync(fd, head, 0, 2, 0);
    return head[0] === 0x23 && head[1] === 0x21; // "#!"
  } catch {
    return false; // no readable bunx here → not a shim we need to drop
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Strip PATH entries whose `bunx` is a `#!` shim, so a real bunx binary wins. */
export function pathWithoutBrokenBunxShims(rawPath: string | undefined): string {
  return (rawPath ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0 && !bunxIsScriptShim(dir))
    .join(delimiter);
}
