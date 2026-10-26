// The account photo, cut round, for a native bar item. UIKit draws a bar item's
// image as it is (no clipping), so a square photo shows as a square. Here the
// photo is loaded and squared by expo-image-manipulator (already installed),
// read back as PNG, masked to a circle in JavaScript and handed over as a PNG
// data URI. No new native code, so the runtime fingerprint is unchanged.
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import { maskToCircle } from './circle-mask';
import { base64ToBytes, bytesToBase64, decodePng, encodePng } from './png-codec';

/** A round photo ready for a bar item: a PNG data URI and its pixel size. */
export type RoundAvatarImage = { uri: string; pixelSize: number };

// One render per photo and size for the app's life: the header rebuilds its
// items on every tab, and the avatar URL carries a `?v=` that changes on upload.
const roundAvatarCache = new Map<string, Promise<RoundAvatarImage | null>>();

/**
 * The round version of `photoUri` at `pixelSize` square, or `null` when it
 * cannot be made (no network, a dead URL, a PNG this reader does not take).
 * Cached per URL and size; a failure is forgotten so the next mount retries.
 */
export function loadRoundAvatar(photoUri: string, pixelSize: number): Promise<RoundAvatarImage | null> {
  const cacheKey = `${pixelSize}|${photoUri}`;
  const cached = roundAvatarCache.get(cacheKey);
  if (cached) return cached;
  const pending = renderRoundAvatar(photoUri, pixelSize).then(
    (image) => {
      if (!image) roundAvatarCache.delete(cacheKey);
      return image;
    },
    () => {
      roundAvatarCache.delete(cacheKey);
      return null;
    },
  );
  roundAvatarCache.set(cacheKey, pending);
  return pending;
}

/** Forgets every round photo; for tests. */
export function clearRoundAvatarCache(): void {
  roundAvatarCache.clear();
}

async function renderRoundAvatar(photoUri: string, pixelSize: number): Promise<RoundAvatarImage | null> {
  const refs: ImageRef[] = [];
  try {
    const source = await ImageManipulator.manipulate(photoUri).renderAsync();
    refs.push(source);
    const side = Math.min(source.width, source.height);
    if (!(side > 0)) return null;
    const squared = await ImageManipulator.manipulate(source)
      .crop({
        originX: Math.floor((source.width - side) / 2),
        originY: Math.floor((source.height - side) / 2),
        width: side,
        height: side,
      })
      .resize({ width: pixelSize, height: pixelSize })
      .renderAsync();
    refs.push(squared);
    const saved = await squared.saveAsync({ format: SaveFormat.PNG, base64: true });
    if (!saved.base64) return null;
    const decoded = decodePng(base64ToBytes(saved.base64));
    if (!decoded) return null;
    const round = encodePng(maskToCircle(decoded));
    return { uri: `data:image/png;base64,${bytesToBase64(round)}`, pixelSize: decoded.width };
  } finally {
    for (const ref of refs) ref.release();
  }
}
