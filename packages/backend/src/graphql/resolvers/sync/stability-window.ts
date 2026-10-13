/**
 * The sync stability window: rows younger than this are left for a later pull,
 * so a cursor never passes a row an older, still-open transaction is about to
 * commit behind it.
 *
 * One reader for every place that applies it. The live pulls
 * (`sync/queries.ts`) and the snapshot exporter
 * (`scripts/export-board-snapshots.ts`) must use the same value: a device
 * resumes the REFERENCE stream from an artifact's watermark, so an exporter that
 * read a shorter window could stamp a watermark past a row still in flight, and
 * the stream would never deliver that row.
 *
 * Keep a deployed document delay. A membership withdrawal is stamped one second
 * before the climb's new row, so it covers every older copy only while the
 * window stays above one second.
 */
const MINIMUM_STABILITY_WINDOW_SECONDS = 2;
const DEFAULT_STABILITY_WINDOW_SECONDS = 30;

export function resolveSyncStabilityWindowSeconds(
  configuredWindow: string | undefined,
  environment: string | undefined,
): number {
  // Blank is unset, as an unset GitHub Actions `vars.*` passthrough arrives;
  // Number('') would read it as zero.
  const trimmedWindow = configuredWindow?.trim();
  const parsedWindow = trimmedWindow ? Number(trimmedWindow) : DEFAULT_STABILITY_WINDOW_SECONDS;
  // Real-database fixtures must read their own writes immediately. This exact
  // zero override is available only in the test runtime, never a deployed one.
  if (environment === 'test' && parsedWindow === 0) return 0;
  return Number.isFinite(parsedWindow)
    ? Math.max(MINIMUM_STABILITY_WINDOW_SECONDS, parsedWindow)
    : DEFAULT_STABILITY_WINDOW_SECONDS;
}

/** The two variables the window is read from. `process.env` is one. */
export type StabilityWindowEnvironment = { SYNC_STABILITY_WINDOW_SECONDS?: string; NODE_ENV?: string };

/** The window, read from `SYNC_STABILITY_WINDOW_SECONDS` in the given environment. */
export function syncStabilityWindowSeconds(environment: StabilityWindowEnvironment = process.env): number {
  return resolveSyncStabilityWindowSeconds(environment.SYNC_STABILITY_WINDOW_SECONDS, environment.NODE_ENV);
}
