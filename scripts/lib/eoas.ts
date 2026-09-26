/// <reference types="node" />

/**
 * Shared helpers for invoking the self-hosted OTA CLI (`eoas`, the expo-open-ota
 * client) via `vp dlx`. Used by both the production publish (scripts/mobile-publish.ts)
 * and the rollback runbook (scripts/mobile-ota-rollback.ts). Kept dependency-free
 * so the lib layer never imports a sibling orchestrator script.
 */

// The eoas CLI spec passed to `vp dlx`. Pinned, not `@latest`: V3 routes are
// app-scoped, so a v2 CLI 404s against our self-hosted server.
//
// The CLI and the server move together. Neither build exchanges a version (no
// cliVersion/serverVersion handshake exists), so compatibility is a property of
// the wire, and at 3.2.0 the wire broke both ways: `requestUploadUrl` takes a
// `files` list instead of `fileNames`, with no fallback on either side. A CLI
// that trails the server can also 404 on app-scoped routes. So
// scripts/ota-image-bump.ts moves this pin and OTA_SERVER_VERSION
// (infra/railway/config.ts) in one commit, and the publish on that commit waits
// for the server to roll (scripts/mobile-ota-server-ready.mjs). See
// docs/mobile-ota-updates.md, "The 3.2 upgrade".
//
// Railway pulls the image under its PRE-RENAME name
// `ghcr.io/mercuretechnologies/expo-open-ota:v3.2.4` (the project renamed
// expo-open-ota → xprem at v3.1.0 and still publishes the old name), so reading
// the Railway dashboard for `xprem:` and finding nothing does not mean the server
// is behind.
//
// Since 3.1.2 the CLI retries 429/5xx itself, honours `Retry-After`, and paces
// uploads with `--upload-rate`: the upstream fixes for the Tigris `SlowDown`
// throttling in #3620.
//
// Single source of truth: imported by mobile-publish.ts, mobile-ota-rollback.ts,
// mobile-ota-setup.ts, and asserted by the rollback + version-parity tests so a
// stale copy can't creep back in per-file.
export const EOAS_PACKAGE_SPEC = 'eoas@3.2.4';

// Asset-upload starts per second for a self-hosted publish, passed as
// `eoas publish --upload-rate`. The CLI default is 10; we run 5 because the
// limiter is PER PROCESS while our preview publishes are per-PR concurrent —
// 11 simultaneous publish jobs were measured on 2026-08-19, which at the default
// would aim ~110 upload starts/sec at the one `boardsesh-ota-v3` bucket. At 5
// that peak is ~55/sec, and a lone publish still starts all 380 assets of a full
// bundle inside ~76 seconds.
export const SELF_HOSTED_UPLOAD_RATE_PER_SECOND = 5;
