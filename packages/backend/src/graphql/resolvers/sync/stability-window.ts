/** Publication tombstones precede the replacement row by one second. */
const MINIMUM_STABILITY_WINDOW_SECONDS = 2;
const DEFAULT_STABILITY_WINDOW_SECONDS = 30;

export function resolveSyncStabilityWindowSeconds(
  configuredWindow: string | undefined,
  environment: string | undefined,
): number {
  const parsedWindow = Number(configuredWindow ?? DEFAULT_STABILITY_WINDOW_SECONDS);
  // Real-database fixtures must read their own writes immediately. This exact
  // zero override is available only in the test runtime, never a deployed one.
  if (environment === 'test' && parsedWindow === 0) return 0;
  return Number.isFinite(parsedWindow)
    ? Math.max(MINIMUM_STABILITY_WINDOW_SECONDS, parsedWindow)
    : DEFAULT_STABILITY_WINDOW_SECONDS;
}
