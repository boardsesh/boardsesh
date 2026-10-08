import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { runOnJS, useAnimatedReaction, type SharedValue } from 'react-native-reanimated';

/**
 * A sharper copy of a board's background photo, fetched only once the board is
 * zoomed in far enough to need it (#5911).
 *
 * Same picture and same frame as the base photo, just more pixels: it is drawn
 * `fill` into the same box, so it lines up with every ring drawn over the base.
 */
export type FullResolutionPhoto = {
  /** Presigned GET. A new signature for the same photo arrives on every refetch. */
  uri: string;
  /**
   * Names the photo rather than the signature, so a refetch that re-signs the
   * URL finds the decoded image already in memory instead of downloading it again.
   */
  cacheKey: string;
  /** The zoom the board has to pass before the photo is fetched. */
  minScale: number;
  /**
   * Fetch the photo into a file this app keeps, resolving its path, or `null`
   * when it could not (the layer then loads `uri`). Called once the zoom first
   * passes `minScale`, never before. Left out, the layer loads `uri` directly.
   */
  loadFromDisk?: () => Promise<string | null>;
  /** Delete the kept file: it would not decode. */
  discardFromDisk?: () => void;
};

/** What `loadFromDisk` answered, for the photo named by `cacheKey`. */
type DiskAnswer = { cacheKey: string; path: string | null };

type FullResolutionPhotoLayerProps = {
  photo: FullResolutionPhoto;
  /** The board's live zoom. */
  scaleSV: SharedValue<number>;
  /** The photo would not load. The base photo stays underneath, so nothing goes blank. */
  onError?: () => void;
};

/**
 * Drawn directly over the base photo, inside the board's zoom transform.
 *
 * Nothing mounts until the zoom first passes `minScale`: a 4096x3072 photo is
 * about 48 MB decoded, and most visits never zoom that far. Once fetched it
 * stays for the rest of the visit, so zooming out and back in neither re-decodes
 * it nor swaps the photo back and forth. Until it has loaded the base shows
 * through, which is why the swap has no flash: the base is the placeholder.
 */
export const FullResolutionPhotoLayer = React.memo(function FullResolutionPhotoLayer({
  photo,
  scaleSV,
  onError,
}: FullResolutionPhotoLayerProps) {
  const [wanted, setWanted] = useState(false);
  const [diskAnswer, setDiskAnswer] = useState<DiskAnswer | null>(null);
  // A kept file that would not decode. Set, the layer loads the URL instead, so a
  // bad file costs one download rather than a sharp photo for good.
  const [unreadableFileKey, setUnreadableFileKey] = useState<string | null>(null);
  const { minScale, loadFromDisk, discardFromDisk, cacheKey } = photo;

  // One crossing is all it takes, so the JS thread hears about it once: the
  // reaction only fires when the answer flips, and only the first flip to true
  // matters. Never a per-frame `runOnJS`.
  useAnimatedReaction(
    () => scaleSV.value > minScale,
    (pastMinScale, previous) => {
      if (pastMinScale && pastMinScale !== previous) runOnJS(setWanted)(true);
    },
    [scaleSV, minScale],
  );

  // A re-signed URL hands over a new `loadFromDisk` for the same photo. The
  // answer already on screen stays (it is keyed on the photo, not the URL) until
  // the new one lands, so a refetch never blanks the sharp layer.
  useEffect(() => {
    if (!wanted || !loadFromDisk) return;
    let current = true;
    loadFromDisk().then(
      (path) => {
        if (current) setDiskAnswer({ cacheKey, path });
      },
      () => {
        if (current) setDiskAnswer({ cacheKey, path: null });
      },
    );
    return () => {
      current = false;
    };
  }, [wanted, loadFromDisk, cacheKey]);

  const answer = diskAnswer?.cacheKey === cacheKey ? diskAnswer : null;
  const filePath = answer?.path && unreadableFileKey !== cacheKey ? answer.path : null;
  const handleError = useCallback(() => {
    if (!filePath) {
      onError?.();
      return;
    }
    // Deleted, so the next visit downloads a good copy rather than failing on
    // this one again.
    discardFromDisk?.();
    setUnreadableFileKey(cacheKey);
  }, [filePath, cacheKey, onError, discardFromDisk]);

  if (!wanted) return null;
  // Still fetching to disk: the base shows through, the same as while a URL loads.
  if (loadFromDisk && !answer) return null;
  return (
    <Image
      source={{ uri: filePath ? `file://${filePath}` : photo.uri, cacheKey }}
      style={StyleSheet.absoluteFill}
      contentFit="fill"
      // Without this, expo-image on iOS resizes the bitmap to the view's
      // un-zoomed pixel size (about 1179 px across on an iPhone), which is
      // smaller than the 2048 px base and throws away the pixels it was
      // fetched for. The zoom transform scales the view, not its layout box.
      allowDownscaling={false}
      // Memory only: the file on disk, when there is one, is this app's own copy
      // under the spray-wall cache (`ensureSprayFullPhotoCached`), which sign-out
      // and wall withdrawal erase. A second copy in expo-image's shared disk
      // cache would outlive both.
      cachePolicy="memory"
      onError={handleError}
      accessible={false}
    />
  );
});
