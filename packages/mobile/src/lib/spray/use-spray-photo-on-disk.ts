// Whether a spray wall's photo is on disk, for a surface that would rather show
// a placeholder than a half-drawn wall.
//
// A board surface draws a wall from its render data, whose background key names
// the photo (or the generated look) of one version. Until that file is on disk,
// `BoardImageNative` draws a grey "missing layer" block, which on a 44pt thumbnail
// reads as a broken image. A thumbnail asks here first and shows its camera glyph
// until the answer is yes.

import { useEffect, useMemo, useState } from 'react';
import { parseSprayBackgroundKey, sprayPhotoFileName } from './spray-photo-keys';
import { ensureSprayPhotoCached, tryGetSprayPhotoPathSync } from './spray-photo-cache';

/**
 * `true` once the photo behind `backgroundImageKeys[0]` is on disk; `false` for
 * no render data, a non-spray key, or a photo still downloading.
 *
 * Reads the cache synchronously, so a photo already there draws on the first
 * frame. Otherwise it asks for the download (shared with any other surface
 * fetching the same file) and re-renders when it lands. A failed download stays
 * `false`: the placeholder is the honest answer.
 */
export function useSprayPhotoOnDisk(renderData: { backgroundImageKeys: readonly string[] } | null): boolean {
  const backgroundKey = renderData?.backgroundImageKeys[0] ?? null;
  const identity = useMemo(() => (backgroundKey ? parseSprayBackgroundKey(backgroundKey) : null), [backgroundKey]);
  const [downloadedFileName, setDownloadedFileName] = useState<string | null>(null);
  const onDisk = useMemo(
    () =>
      identity !== null &&
      (downloadedFileName === sprayPhotoFileName(identity) || tryGetSprayPhotoPathSync(identity) !== null),
    [identity, downloadedFileName],
  );

  useEffect(() => {
    if (identity === null || onDisk) return;
    let cancelled = false;
    ensureSprayPhotoCached(identity).then(
      (path) => {
        if (!cancelled && path) setDownloadedFileName(sprayPhotoFileName(identity));
      },
      () => {
        // A failed download keeps the placeholder; the wall's own screen reports it.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [identity, onDisk]);

  return onDisk;
}
