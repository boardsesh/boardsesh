import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';

/** Pure route classification shared by Edge middleware and the final Node writer. */
export function isClimbViewRequest(pathname: string): boolean {
  let candidate = pathname;
  for (let decoding = 0; decoding <= 2; decoding++) {
    // Match structural segments first: an encoded slash inside a climb name
    // remains one dynamic leaf when Next matches the route.
    const pathParts = candidate.toLowerCase().split('/').filter(Boolean);
    if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(pathParts[0] ?? '')) pathParts.shift();
    const isSlugFormat = pathParts.length === 5 && pathParts[0] === 'b' && pathParts[3] === 'view';
    const isBoardFormat =
      pathParts.length === 7 &&
      (SUPPORTED_BOARDS as readonly string[]).includes(pathParts[0]) &&
      pathParts[5] === 'view';
    if (isSlugFormat || isBoardFormat) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) break;
      candidate = decoded;
    } catch {
      break;
    }
  }
  return false;
}
