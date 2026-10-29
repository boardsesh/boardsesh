import { useMemo } from 'react';
import { Platform } from 'react-native';
import { wallGlowSurfaces } from '../../theme/colors';
import {
  blobGradient,
  wallGlowBlobs,
  wallGlowLabelFade,
  type GlowHold,
  type WallGlowBlend,
  type WallGlowBlob,
  type WallGlowSurface,
} from './wall-glow';

/**
 * What the lit wall button glows with: the climb's lit holds on the board, and
 * a key that changes with the climb, the playback frame or the colours, so the
 * glow cross-fades only when what it shows changes.
 */
export type WallGlowInput = {
  key: string;
  holds: readonly GlowHold[];
  boardWidth: number;
  boardHeight: number;
};

/** One drawn glow: blobs with their CSS ready, and the label fade. */
export type WallGlowLayer = {
  key: string;
  blobs: readonly (WallGlowBlob & { gradient: string })[];
  fade: number;
  surface: WallGlowSurface;
  blend: WallGlowBlend;
  opacityScale: number;
};

/**
 * Screen blending needs Android 10 (API 29); below it the glow composites
 * normally at a lower strength, so it still reads as light, not paint.
 */
export function wallGlowBlendFor(scheme: 'light' | 'dark'): { blend: WallGlowBlend; opacityScale: number } {
  const blendSupported = Platform.OS !== 'android' || (typeof Platform.Version === 'number' && Platform.Version >= 29);
  if (!blendSupported) return { blend: 'normal', opacityScale: 0.6 };
  // On the pale light fill, light can't brighten: the colours multiply in, softer.
  return scheme === 'light' ? { blend: 'multiply', opacityScale: 0.6 } : { blend: 'screen', opacityScale: 1 };
}

/**
 * The glow for a pill of this size, or `null` (the flat amber) with no holds,
 * no size yet, or nothing to glow for. Memoised on the input's identity and the
 * size: the player hands a new input only when the climb, the frame or the
 * colours change.
 */
export function useWallGlowLayer(
  input: WallGlowInput | null,
  width: number,
  height: number,
  scheme: 'light' | 'dark',
): WallGlowLayer | null {
  return useMemo(() => {
    if (!input || width <= 0 || height <= 0) return null;
    const pill = { w: width, h: height };
    const blobs = wallGlowBlobs({
      holds: input.holds,
      boardWidth: input.boardWidth,
      boardHeight: input.boardHeight,
      pill,
    });
    if (blobs.length === 0) return null;
    const surface = wallGlowSurfaces[scheme];
    const { blend, opacityScale } = wallGlowBlendFor(scheme);
    return {
      key: input.key,
      blobs: blobs.map((blob) => ({ ...blob, gradient: blobGradient(blob, opacityScale) })),
      fade: wallGlowLabelFade(blobs, pill, { surface, blend, opacityScale }),
      surface,
      blend,
      opacityScale,
    };
  }, [input, width, height, scheme]);
}
