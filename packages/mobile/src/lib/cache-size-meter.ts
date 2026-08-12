// A short memo in front of the cache-directory walk (issue #3647).
//
// Measuring a cache directory is a full walk — there is no cheap stat (see
// cache-dir-io.ts). Manage Storage re-measures on every focus, and the sweeper
// wants the same number, so without a memo the two of them race two thousand-file
// walks past each other every time you tab back to the screen.
//
// A minute is long enough that focus churn costs one walk, and short enough that
// the figure on screen is never meaningfully behind the disk. Anything that
// mutates a directory invalidates it explicitly, so a Clear or a sweep shows its
// result immediately rather than after a TTL.

const MEASUREMENT_TTL_MS = 60_000;

type Measurement = { bytes: number | null; measuredAtMs: number };

const measurements = new Map<string, Measurement>();

/** Read a fresh-enough measurement, or null when one needs taking. */
export function readCachedMeasurement(dirName: string, nowMs = Date.now()): number | null | undefined {
  const measurement = measurements.get(dirName);
  if (!measurement) return undefined;
  if (nowMs - measurement.measuredAtMs >= MEASUREMENT_TTL_MS) return undefined;
  return measurement.bytes;
}

/** Record a measurement someone already took — a sweep's walk counts as one. */
export function recordCacheMeasurement(dirName: string, bytes: number | null, nowMs = Date.now()): void {
  measurements.set(dirName, { bytes, measuredAtMs: nowMs });
}

/** Drop one directory's memo, or all of them. Call after anything that deletes. */
export function invalidateCacheMeasurement(dirName?: string): void {
  if (dirName === undefined) measurements.clear();
  else measurements.delete(dirName);
}

/**
 * Measure a directory, reusing a recent measurement when there is one.
 *
 * `measure` returns null for "directory absent", which is memoized too: probing
 * a directory that isn't there is still a syscall, and on a device where
 * expo-image's cache name doesn't match our allowlist that probe would otherwise
 * repeat on every screen focus forever.
 */
export async function measureCacheDirBytes(
  dirName: string,
  measure: () => Promise<number | null>,
  nowMs = Date.now(),
): Promise<number | null> {
  const cached = readCachedMeasurement(dirName, nowMs);
  if (cached !== undefined) return cached;
  const bytes = await measure();
  recordCacheMeasurement(dirName, bytes, Date.now());
  return bytes;
}
