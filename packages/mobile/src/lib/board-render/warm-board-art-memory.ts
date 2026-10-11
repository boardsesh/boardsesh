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
import { noteBoardArtInMemory } from './board-art-memory-index';
export { noteBoardArtInMemory, isBoardArtInMemory, forgetBoardArtInMemory } from './board-art-memory-index';

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
 * by bytes (256 MB on iOS, see `useImageCacheMemoryManagement`). A list
 * thumbnail decodes to about 0.7 MB, so the cache holds a few hundred — fewer
 * once the play drawer has been open, since each play-size overlay is ~7 MB and
 * the full board photo ~11 MB. At 240 a long run on an iPhone 13 Pro showed 38
 * of 1,505 thumbnails believed in memory that were not; 160 leaves that room.
 * A stale yes costs a few frames of bare board; a stale no costs a placeholder.
 */
function isLocalFileUri(uri: string): boolean {
  return uri.startsWith('file://');
}

/** Best effort: a miss only means the view decodes the file itself. */
export function warmBoardArtMemory(uris: readonly string[], generation?: string): void {
  if (!canWarmBoardArtMemory()) return;
  const localUris = uris.filter(isLocalFileUri);
  if (localUris.length === 0) return;
  void Image.prefetch(localUris, 'memory')
    .then((decoded) => {
      // One answer for the batch: true only when every file decoded, false as
      // soon as one failed. On false nothing is recorded, which errs towards a
      // placeholder for files that did make it.
      if (decoded) for (const uri of localUris) noteBoardArtInMemory(uri, generation);
    })
    .catch(() => {});
}
