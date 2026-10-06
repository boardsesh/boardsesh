/** Public native-store metadata; deliberately independent of GraphQL and platform APIs. */
export type MobileStorePlatform = 'ios' | 'android';
export type MobileStoreRelease = {
  latestVersion: string;
  firstNewerMinorAvailableAt: string;
  checkedAt: string;
  storeUrl: string;
};
export type StoreReleaseSnapshot = {
  schemaVersion: 1;
  checkedAt: string;
  latestVersion: string | null;
  firstPublicAtByMinor: Record<string, string>;
};

export function parseNumericVersion(version: string | null | undefined): [number, number, number] | null {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return null;
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function compareNumericVersions(left: string, right: string): number | null {
  const leftParts = parseNumericVersion(left);
  const rightParts = parseNumericVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function timestampMs(input: unknown): number | null {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return null;
  const milliseconds = Date.parse(input);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input ? milliseconds : null;
}

export function parseStoreReleaseSnapshot(input: unknown): StoreReleaseSnapshot | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const checkedMs = timestampMs(record.checkedAt);
  if (record.schemaVersion !== 1 || checkedMs === null) return null;
  if (record.latestVersion !== null && !parseNumericVersion(record.latestVersion as string)) return null;
  const history = record.firstPublicAtByMinor;
  if (typeof history !== 'object' || history === null || Array.isArray(history)) return null;
  const firstPublicAtByMinor: Record<string, string> = {};
  for (const [minor, firstAt] of Object.entries(history)) {
    const firstMs = timestampMs(firstAt);
    if (!parseNumericVersion(`${minor}.0`) || firstMs === null || firstMs > checkedMs) return null;
    firstPublicAtByMinor[minor] = firstAt as string;
  }
  if (typeof record.latestVersion === 'string') {
    const [major, minor] = parseNumericVersion(record.latestVersion)!;
    if (!firstPublicAtByMinor[`${major}.${minor}`]) return null;
  }
  return {
    schemaVersion: 1,
    checkedAt: record.checkedAt as string,
    latestVersion: record.latestVersion as string | null,
    firstPublicAtByMinor,
  };
}

export function resolveMobileStoreRelease(
  snapshot: StoreReleaseSnapshot,
  nativeVersion: string,
  storeUrl: string,
  nowMs: number,
): MobileStoreRelease | null {
  const validSnapshot = parseStoreReleaseSnapshot(snapshot);
  const installed = parseNumericVersion(nativeVersion);
  if (!validSnapshot || !installed || !Number.isFinite(nowMs) || !validSnapshot.latestVersion) return null;
  const checkedMs = Date.parse(validSnapshot.checkedAt);
  if (checkedMs > nowMs || nowMs - checkedMs > 24 * 60 * 60 * 1000) return null;
  const latest = parseNumericVersion(validSnapshot.latestVersion)!;
  if (latest[0] < installed[0] || (latest[0] === installed[0] && latest[1] <= installed[1])) return null;
  const qualifyingDates = Object.entries(validSnapshot.firstPublicAtByMinor)
    .filter(
      ([minor]) =>
        compareNumericVersions(`${minor}.0`, `${installed[0]}.${installed[1]}.0`) === 1 &&
        compareNumericVersions(`${minor}.0`, `${latest[0]}.${latest[1]}.0`)! <= 0,
    )
    .map(([, firstAt]) => firstAt)
    .sort();
  if (!qualifyingDates[0]) return null;
  return {
    latestVersion: validSnapshot.latestVersion,
    firstNewerMinorAvailableAt: qualifyingDates[0],
    checkedAt: validSnapshot.checkedAt,
    storeUrl,
  };
}
