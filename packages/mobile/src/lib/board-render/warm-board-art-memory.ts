/**
 * Decode board art that is ALREADY A FILE ON THIS PHONE into expo-image's
 * memory cache, and remember which files are in it.
 *
 * A view only paints an image on the frame it mounts when the decoded bitmap is
 * already in memory. Otherwise it decodes first, and on a fast scroll that is
 * several frames of a board with no holds on it. So surfaces ask
 * `isBoardArtInMemory` before deciding to show the board straight away, and
 * hold it back behind a placeholder when the answer is no.
 *
 * Never a download. Board art comes from bundled assets and from the native
 * renderer's own PNGs; fetching it over HTTP is forbidden
 * (`scripts/mobile-board-art-network-check.ts`). This is the one file that guard
 * lets call `Image.prefetch`, and only because of the filter below: anything
 * that is not a `file://` URI is dropped before the call.
 */
import { Platform } from 'react-native';
import { Image } from 'expo-image';

/**
 * iOS only. expo-image's Android prefetch loads every URL as a `GlideUrl`,
 * which goes to the network stack, while its views load a `file://` source as a
 * plain model — so on Android a prefetch of a local file warms nothing a view
 * will ever look up. There a file only counts as in memory once a view has
 * loaded it (`noteBoardArtInMemory`).
 *
 * Read when a warm-up is asked for, not at import: this module is pulled in by
 * `LayeredClimbImage`, and a test that mocks `react-native` down to `View` must
 * still be able to load it.
 */
function canWarmBoardArtMemory(): boolean {
  return Platform.OS === 'ios';
}

/**
 * How many files to believe are still decoded. The image memory cache is capped
 * by bytes (256 MB on iOS, see `useImageCacheMemoryManagement`), about 320 list
 * thumbnails; staying under that keeps "in memory" true in practice. A stale
 * yes costs a few frames of bare board; a stale no costs a placeholder.
 */
const IN_MEMORY_URIS_MAX = 240;

// Insertion order is recency: a re-noted URI moves to the end.
const inMemoryUris = new Set<string>();

function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://');
}

/** A view finished loading this file, or a warm-up decoded it. */
export function noteBoardArtInMemory(uri: string): void {
  inMemoryUris.delete(uri);
  inMemoryUris.add(uri);
  if (inMemoryUris.size > IN_MEMORY_URIS_MAX) {
    const oldest = inMemoryUris.values().next().value;
    if (oldest !== undefined) inMemoryUris.delete(oldest);
  }
}

/** Whether a view mounting this file now would paint it on its first frame. */
export function isBoardArtInMemory(uri: string | null | undefined): boolean {
  return uri != null && inMemoryUris.has(uri);
}

/** The image memory cache was swept (app backgrounded, memory warning, iPad tab switch). */
export function forgetBoardArtInMemory(): void {
  inMemoryUris.clear();
}

/** Best effort: a miss only means the view decodes the file itself. */
export function warmBoardArtMemory(uris: readonly string[]): void {
  if (!canWarmBoardArtMemory()) return;
  const localUris = uris.filter(isLocalFileUri);
  if (localUris.length === 0) return;
  void Image.prefetch(localUris, 'memory')
    .then((decoded) => {
      // One answer for the batch: true only when every file decoded, false as
      // soon as one failed. On false nothing is recorded, which errs towards a
      // placeholder for files that did make it.
      if (decoded) for (const uri of localUris) noteBoardArtInMemory(uri);
    })
    .catch(() => {});
}
