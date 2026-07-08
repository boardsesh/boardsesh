export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'https://ws.boardsesh.com';
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://www.boardsesh.com';

// Base URL for the board-snapshot manifest directory (offline-sync Phase 2/4):
// `${SNAPSHOT_BASE_URL}/manifest.json` is the manifest; each entry's own `url`
// is an absolute artifact URL, so this constant is only used for the manifest
// fetch. Mirrors packages/backend/src/scripts/export-board-snapshots.ts's
// `board-snapshots/v1` key prefix, served from the same Tigris/S3 bucket
// packages/backend/src/storage/s3.ts uploads to. This must be supplied by the
// EAS build environment; there is deliberately no guessed production fallback.
//
// EXPO_PUBLIC_* vars are inlined at build time, not read at runtime.
export const SNAPSHOT_BASE_URL = (process.env.EXPO_PUBLIC_SNAPSHOT_BASE_URL?.trim() ?? '').replace(/\/+$/, '');

export function isSnapshotBaseUrlConfigured(): boolean {
  return SNAPSHOT_BASE_URL.length > 0;
}
