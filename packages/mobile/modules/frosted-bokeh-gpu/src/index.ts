import type { ComponentType } from 'react';
import { Platform, type NativeSyntheticEvent, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

/**
 * One blob, with the platform's opacity scale already in `peak`. `id` (the
 * physical hold) and `seed` (its breathing phase) go only to a binary with
 * `swapFrameApi`.
 */
export type GpuBokehBlob = { x: number; y: number; r: number; peak: number; color: string; id?: number; seed?: number };

/** A climb the board can swap to: its layer key and blobs. */
export type GpuBokehSwapClimb = { key: string; blobs: readonly GpuBokehBlob[] };

/** The board's pages around the climb on show, which sits on `centerPage`. */
export type GpuBokehSwapClimbs = {
  centerPage: number;
  previous: GpuBokehSwapClimb | null;
  next: GpuBokehSwapClimb | null;
};

export type FrostedBokehGPUNativeProps = ViewProps & {
  blobs: readonly GpuBokehBlob[];
  /** Hex base fill, drawn under the blobs. */
  base: string;
  blend: 'screen' | 'multiply' | 'normal';
  /** Changes when what the frost shows changes. */
  layerKey: string;
  /** No breathing; climbs change with a linear dissolve (no front, no glide). */
  reduceMotion: boolean;
  /** `BOKEH_DRIFT` and `BOKEH_SWELL` from `@boardsesh/frosted-bokeh`. */
  drift: number;
  swell: number;
  /**
   * Binaries without `swapFrameApi` only: `BOKEH_GLIDE_MS`, the old slide of
   * each light to the next climb's light in the same slot.
   */
  glideMs?: number;
  /** `swapFrameApi` only: the neighbours the board's swap frames name by page. */
  swapClimbs?: GpuBokehSwapClimbs | null;
  /** `swapFrameApi` only: the board's encoded swap look (`encodeSwapLook`). */
  swapLook?: readonly number[] | null;
  /** `swapFrameApi` only: `BOKEH_SWAP_MS`, `BOKEH_SWAP_OUT_MS` and `BOKEH_DISSOLVE_MS`. */
  releaseMs?: number;
  releaseOutMs?: number;
  dissolveMs?: number;
  /**
   * `swapFrameApi` only: the animated-prop copy of the `swapFrame` command (a
   * sequenced board frame, or `[sequence]` for "no frames"), for mount.
   */
  swapFrame?: readonly number[];
  /** The shader could not compile or a frame could not be encoded: draw the blobs another way. */
  onRenderError?: (event: NativeSyntheticEvent<{ reason: string }>) => void;
};

// Older binaries and Expo Go keep the React Native fallback. Android's AGSL
// renderer needs API 33; never resolve its native view on older OS versions.
const supported = Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 33);
const frostedBokehGPUNative = supported
  ? requireOptionalNativeModule<{ swapFrameApi?: unknown }>('FrostedBokehGPU')
  : null;

/**
 * 1 when the native view follows the board's swap frames (the `swapFrame`
 * command and the `swapClimbs` / `swapLook` props), else 0. Older binaries
 * ignore those and keep the index glide, so the app sends them only from 1.
 */
export const frostedBokehSwapFrameApi: number =
  typeof frostedBokehGPUNative?.swapFrameApi === 'number' &&
  Number.isSafeInteger(frostedBokehGPUNative.swapFrameApi) &&
  frostedBokehGPUNative.swapFrameApi > 0
    ? frostedBokehGPUNative.swapFrameApi
    : 0;

/** The native view, or null when the running binary does not have it. */
export const NativeFrostedBokehGPU: ComponentType<FrostedBokehGPUNativeProps> | null = frostedBokehGPUNative
  ? requireNativeViewManager<FrostedBokehGPUNativeProps>('FrostedBokehGPU')
  : null;
