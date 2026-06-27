/// <reference types="node" />

/**
 * Shared helpers for invoking the self-hosted OTA CLI (`eoas`, the expo-open-ota
 * client) via `bunx`. Used by both the production publish (scripts/mobile-publish.ts)
 * and the rollback runbook (scripts/mobile-ota-rollback.ts). Kept dependency-free
 * so the lib layer never imports a sibling orchestrator script.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { join, delimiter } from 'node:path';

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
