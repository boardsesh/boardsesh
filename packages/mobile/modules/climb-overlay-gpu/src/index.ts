import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type ClimbOverlayGPUReady = {
  requestId: string;
  prepareMs: number;
  uploadMs: number;
  /** Command-buffer GPU duration; this is not time-to-display. */
  gpuMs: number;
  atlasBytes: number;
  atlasCacheHit: boolean;
};

export type ClimbOverlayGPUNativeProps = ViewProps & {
  configJson: string;
  requestId: string;
  active: boolean;
  onRenderReady?: (event: NativeSyntheticEvent<ClimbOverlayGPUReady>) => void;
  onRenderError?: (event: NativeSyntheticEvent<{ requestId: string; reason: string }>) => void;
};

export type ClimbOverlayGPUComparison = {
  width: number;
  height: number;
  maxChannelError: number;
  rmse: number;
  pixelsOverOne: number;
  cpuRenderMs: number;
  gpuMs: number;
  prepareMs: number;
  uploadMs: number;
  atlasBytes: number;
  atlasCacheHit: boolean;
  gpuUri: string;
  referenceUri: string;
};

const nativeModule = requireOptionalNativeModule<{
  compare(configJson: string): Promise<ClimbOverlayGPUComparison>;
}>('ClimbOverlayGPU');

export const compareClimbOverlayGPU = nativeModule
  ? (configJson: string): Promise<ClimbOverlayGPUComparison> => nativeModule.compare(configJson)
  : null;

export const NativeClimbOverlayGPU: ComponentType<ClimbOverlayGPUNativeProps> | null = nativeModule
  ? requireNativeViewManager<ClimbOverlayGPUNativeProps>('ClimbOverlayGPU')
  : null;
