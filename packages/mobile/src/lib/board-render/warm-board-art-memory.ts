/**
 * Decode board art that is ALREADY A FILE ON THIS PHONE into expo-image's
 * memory cache, so the view that shows it next paints it on the frame it mounts
 * instead of a frame or two later, after its own decode.
 *
 * Never a download. Board art comes from bundled assets and from the native
 * renderer's own PNGs; fetching it over HTTP is forbidden
 * (`scripts/mobile-board-art-network-check.ts`). This is the one file that guard
 * lets call `Image.prefetch`, and only because of the filter below: anything
 * that is not a `file://` URI is dropped before the call.
 */
import { Image } from 'expo-image';

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://');
}

/** Best effort: a miss only means the view decodes the file itself. */
export function warmBoardArtMemory(uris: readonly string[]): void {
  const localUris = uris.filter(isLocalFileUri);
  if (localUris.length === 0) return;
  void Image.prefetch(localUris, 'memory').catch(() => {});
}
