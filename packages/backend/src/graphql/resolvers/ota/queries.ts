import type { OtaPreviewChannel } from '@boardsesh/shared-schema';

/**
 * Retired query, kept alive as an empty answer.
 *
 * The per-PR channel switcher this fed was replaced by xprem Branch Surfing in
 * #4792, which deleted the screen, the resolver and the schema field together.
 * The field deletion is the part that hurt: `GetOtaPreviewChannels` is baked
 * into every store binary built before #4792, and that PR moved the native
 * fingerprint, so those binaries can never pull an OTA that stops sending it.
 * GraphQL validates a document as a whole, so each of those launches got an
 * HTTP 400 `GRAPHQL_VALIDATION_FAILED` and an errored screen rather than a
 * missing list (Sentry BOARDSESH-7H, still firing 2026-09-08 from 2.3.0 /
 * 2.4.0 builds).
 *
 * There is no live data to return — the GitHub deployment source went away with
 * the switcher — and none is wanted: an empty list is exactly what the old
 * screen renders as "no previews right now". Deliberately no I/O, no auth, no
 * cache.
 *
 * Delete this (and the schema field) once the pre-#4792 build tail has updated
 * through the store. See docs/mobile-ota-updates.md.
 */
export const otaQueries = {
  otaPreviewChannels: (): OtaPreviewChannel[] => [],
};
