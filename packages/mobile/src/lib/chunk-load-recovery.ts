// NATIVE FORK — a constant module. Native never loads JS chunks over the network.
//
// A store binary runs one embedded (or OTA-downloaded) bundle, so there is no
// route chunk that a later deploy can delete out from under it. The recovery in
// `chunk-load-recovery.web.ts` exists for app.boardsesh.com only (#5611): a tab
// opened before a deploy asks for route chunks the new deploy no longer serves.
//
// Every merge touching `packages/mobile/**` ships as an OTA to the whole store
// fleet, so this fork stays inert rather than branching on `Platform.OS`: no
// browser global is referenced here, and the root error boundary behaves on
// native exactly as it did before. A parity test compares the export keys of
// both forks so a symbol added to one cannot go missing from the other.

export type ChunkLoadCause = 'stale-deploy' | 'transient' | 'network' | 'offline';

/**
 * What the recovery did: reloaded the page, or left a manual Reload button —
 * because the browser is offline, because it reports online but the origin did
 * not answer, or because the automatic reloads are spent.
 */
export type ChunkRecoveryOutcome = 'reloading' | 'offline' | 'unreachable' | 'exhausted';

/** Shared with the inline shell script in `public/index.html` (web only). */
export const CHUNK_RELOAD_GUARD_KEY = 'boardsesh:chunk-reload-at';

/** Shared with the inline shell script in `public/index.html` (web only). */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

/** Shared with the inline shell script in `public/index.html` (web only). */
export const CHUNK_RELOAD_COUNT_KEY = 'boardsesh:chunk-reload-count';

/** Shared with the inline shell script in `public/index.html` (web only). */
export const CHUNK_RELOAD_MAX_PER_TAB = 3;

/** Shared with the inline shell script in `public/index.html` (web only). */
export const ROOT_LAYOUT_LOADED_FLAG = '__BOARDSESH_ROOT_LAYOUT_LOADED__';

/** Constant `false`: native has no async route chunks to fail. */
export function isChunkLoadError(_error: unknown): boolean {
  return false;
}

/** Never reached on native (see `isChunkLoadError`); reports nothing, reloads nothing. */
export async function recoverFromChunkLoadError(_error: unknown): Promise<ChunkRecoveryOutcome> {
  return 'exhausted';
}

/** No-op: native has no shell script waiting on the root layout. */
export function markRootLayoutLoaded(): void {}

/** No-op: native has no page to reload. */
export function reloadPage(): void {}
