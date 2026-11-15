import type { ComponentType } from 'react';
import { Platform, type NativeSyntheticEvent, type ViewProps } from 'react-native';
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

// Older binaries and Expo Go keep the React Native fallback. Android's AGSL
// renderer needs API 33; never resolve its native view on older OS versions.
const supported = Platform.OS === 'ios' || (Platform.OS === 'android' && Number(Platform.Version) >= 33);
const frostedBokehGPUNative = supported ? requireOptionalNativeModule<object>('FrostedBokehGPU') : null;

/** The native view, or null when the running binary does not have it. */
export const NativeFrostedBokehGPU: ComponentType<FrostedBokehGPUNativeProps> | null = frostedBokehGPUNative
  ? requireNativeViewManager<FrostedBokehGPUNativeProps>('FrostedBokehGPU')
  : null;
