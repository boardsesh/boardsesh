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
// Two server-side halves ride the same version, and both are now available:
// Railway runs v3.1.2, published under the PRE-RENAME image name
// `ghcr.io/mercuretechnologies/expo-open-ota:v3.1.2` (the project renamed
// expo-open-ota → xprem at v3.1.0 and still publishes the old name), so reading
// the Railway dashboard for `xprem:` and finding nothing does not mean the server
// is behind. Branch surfing answering on the live server confirms it: that route
// first shipped in v3.1.2-beta2.
//   * server-side reuse of the previous update's assets (xprem #165) — the half
//     that drops a repeat publish from ~380 uploads to a handful; and
//   * `vp run mobile:ota-rollback -- --mode republish`: 3.1.2 lists candidates
//     through a new `.../runtimeVersion/<rv>/publish-groups` route that 3.0.5 does
//     not serve, with the back-compat living server-side (xprem #168). `--mode
//     embedded`, the mode the rollback runbook actually uses, is unaffected, and
//     the helper warns before running republish.
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
