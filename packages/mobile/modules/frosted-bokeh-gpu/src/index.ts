import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

/** One blob, with the platform's opacity scale already in `peak`. */
export type GpuBokehBlob = { x: number; y: number; r: number; peak: number; color: string };

export type FrostedBokehGPUNativeProps = ViewProps & {
  blobs: readonly GpuBokehBlob[];
  /** Hex base fill, drawn under the blobs. */
  base: string;
  blend: 'screen' | 'multiply' | 'normal';
  /** Changes when what the frost shows changes; a new key glides to the new blobs. */
  layerKey: string;
  /** No breathing and no glide: the new climb's lights appear in place. */
  reduceMotion: boolean;
  /** `BOKEH_DRIFT`, `BOKEH_SWELL` and `BOKEH_GLIDE_MS` from `@boardsesh/frosted-bokeh`. */
  drift: number;
  swell: number;
  glideMs: number;
  /** The shader could not compile or a frame could not be encoded: draw the blobs another way. */
  onRenderError?: (event: NativeSyntheticEvent<{ reason: string }>) => void;
};

// iOS only, and new with this binary, so JS published as an OTA can land on a
// binary without it. requireOptionalNativeModule returns null there (and on
// Android, in Expo Go and on the web) without throwing, and the view is only
// asked for when the module is present. The 'FrostedBokehGPU' string must match
// Name("FrostedBokehGPU") in ios/FrostedBokehGPUModule.swift.
const frostedBokehGPUNative = requireOptionalNativeModule<object>('FrostedBokehGPU');

/** The native view, or null when the running binary does not have it. */
export const NativeFrostedBokehGPU: ComponentType<FrostedBokehGPUNativeProps> | null = frostedBokehGPUNative
  ? requireNativeViewManager<FrostedBokehGPUNativeProps>('FrostedBokehGPU')
  : null;
