import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import { frostedBokehPlatformSupported, swapFrameApiOf } from './swap-frame-api';

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
  /** Left out when there is none: the native record takes a missing field as nil. */
  previous?: GpuBokehSwapClimb;
  next?: GpuBokehSwapClimb;
};

export type FrostedBokehGPUNativeProps = ViewProps & {
  blobs: readonly GpuBokehBlob[];
  /** Hex base fill, drawn under the blobs. */
  base: string;
  blend: 'screen' | 'multiply' | 'normal';
  /** Changes when what the frost shows changes. */
  layerKey: string;
  /** No breathing. (The wall button draws a still frost under Reduce Motion.) */
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
  /** `swapFrameApi` only: `BOKEH_SWAP_MS` and `BOKEH_SWAP_OUT_MS`. */
  releaseMs?: number;
  releaseOutMs?: number;
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
const frostedBokehGPUNative = frostedBokehPlatformSupported()
  ? requireOptionalNativeModule<{ swapFrameApi?: unknown }>('FrostedBokehGPU')
  : null;

/**
 * 1 when the native view follows the board's swap frames (the `swapFrame`
 * command and the `swapClimbs` / `swapLook` props), else 0. Older binaries
 * ignore those and keep the index glide, so the app sends them only from 1.
 */
export const frostedBokehSwapFrameApi: number = swapFrameApiOf(frostedBokehGPUNative);

/** The native view, or null when the running binary does not have it. */
export const NativeFrostedBokehGPU: ComponentType<FrostedBokehGPUNativeProps> | null = frostedBokehGPUNative
  ? requireNativeViewManager<FrostedBokehGPUNativeProps>('FrostedBokehGPU')
  : null;
