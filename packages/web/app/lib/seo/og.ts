// OG canvas dimensions + the immutable/short-TTL header builder live in the
// shared @boardsesh/board-render package (also used by the backend OG renderer).
// Re-exported here so web's existing importers keep the same module path.
export { OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, createOgImageHeaders } from '@boardsesh/board-render';

function toVersionMillis(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isFinite(millis) ? millis : null;
  }

  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

export function buildOgVersionToken(...values: Array<Date | string | number | null | undefined>): string {
  let maxMillis = 0;

  for (const value of values) {
    const millis = toVersionMillis(value);
    if (millis !== null && millis > maxMillis) {
      maxMillis = millis;
    }
  }

  return maxMillis.toString(36);
}

export function buildVersionedOgImagePath(
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
  version?: string | null,
): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'boolean') {
      if (value) {
        searchParams.set(key, '1');
      }
      continue;
    }

    searchParams.set(key, String(value));
  }

  if (version) {
    searchParams.set('v', version);
  }

  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
}
