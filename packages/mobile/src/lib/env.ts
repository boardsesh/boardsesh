export const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL ?? 'https://ws.boardsesh.com';
export const WEB_BASE_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://www.boardsesh.com';

// Base URL for the board-snapshot manifest directory (offline-sync Phase 2/4):
// `${SNAPSHOT_BASE_URL}/manifest.json` is the manifest; each entry's own `url`
// is an absolute artifact URL, so this constant is only used for the manifest
// fetch. Mirrors packages/backend/src/scripts/export-board-snapshots.ts's
// `board-snapshots/v1` key prefix, served from the same Tigris/S3 bucket
// packages/backend/src/storage/s3.ts uploads to.
//
// UNCONFIRMED DEFAULT: the actual bucket host/name is only known via the
// backend's AWS_S3_BUCKET_NAME/AWS_ENDPOINT_URL secrets (not visible from this
// worktree). This fallback is a placeholder guess at the Tigris virtual-hosted
// bucket domain — confirm the real value and set it as an EAS build-time env
// var before this ships (EXPO_PUBLIC_* vars are inlined at build time, not read
// at runtime).
export const SNAPSHOT_BASE_URL =
  process.env.EXPO_PUBLIC_SNAPSHOT_BASE_URL ?? 'https://boardsesh-data.fly.storage.tigris.dev/board-snapshots/v1';
