import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type ClimbOverlayGPUReady = {
  requestId: string;
  prepareMs: number;
  uploadMs: number;
  /** GPU duration, or null when the driver cannot measure it; never wall-clock latency. */
  gpuMs: number | null;
  atlasBytes: number;
  atlasCacheHit: boolean;
  editChangedHoldCount?: number;
  editDurationMs?: number;
  lowPowerMode?: boolean;
};

export type ClimbOverlayGPUNativeProps = ViewProps & {
  configJson: string;
  requestId: string;
  active: boolean;
  onRenderReady?: (event: NativeSyntheticEvent<ClimbOverlayGPUReady>) => void;
  onRenderError?: (event: NativeSyntheticEvent<{ requestId: string; reason: string }>) => void;
};

/** v2 separates immutable layout configuration from the changing climb. */
export type ClimbOverlayGPUFrameProps = ClimbOverlayGPUNativeProps & {
  /** configJson must contain frames: ''; only this prop changes per climb. */
  frames: string;
  /** v4/asset API v1: captured once per static configuration, never per frame. */
  geometryAssetPath?: string | null;
  geometryAssetSha256?: string | null;
  generatedGeometryDirectory?: string | null;
};

/** v3 keeps the wall fixed while the gesture changes its lit holds. */
export type ClimbOverlayGPUMotionProps = ClimbOverlayGPUFrameProps & {
  previousFrames: string | null;
  nextFrames: string | null;
  centerPage: number;
  /** Absolute pager position, updated directly from a UI-thread worklet. */
  pagePosition?: number;
  animateEdits: boolean;
  /** The outer view mirrors artwork; only reverse the reveal direction here. */
  displayMirrored?: boolean;
  reduceMotion: boolean;
};

export type ClimbOverlayGPUComparison = {
  width: number;
  height: number;
  maxChannelError: number;
  rmse: number;
  pixelsOverOne: number;
  cpuRenderMs: number;
  gpuMs: number | null;
  prepareMs: number;
  uploadMs: number;
  atlasBytes: number;
  atlasCacheHit: boolean;
  gpuUri: string;
  referenceUri: string;
};

const nativeModule = requireOptionalNativeModule<{
  apiVersion?: number;
  assetApiVersion?: number;
  compare?(configJson: string): Promise<ClimbOverlayGPUComparison>;
}>('ClimbOverlayGPU');

/** Older binaries keep their compatible locally generated rendering path. */
export const climbOverlayGeometryAssetApiVersion =
  typeof nativeModule?.assetApiVersion === 'number' && Number.isFinite(nativeModule.assetApiVersion)
    ? nativeModule.assetApiVersion
    : 0;

// A binary can support live rendering without the optional diagnostic readback.
const nativeCompare = typeof nativeModule?.compare === 'function' ? nativeModule.compare.bind(nativeModule) : null;
export const compareClimbOverlayGPU =
  typeof nativeCompare === 'function'
    ? (configJson: string): Promise<ClimbOverlayGPUComparison> => nativeCompare(configJson)
    : null;

export const NativeClimbOverlayGPU: ComponentType<ClimbOverlayGPUNativeProps> | null = nativeModule
  ? requireNativeViewManager<ClimbOverlayGPUNativeProps>('ClimbOverlayGPU')
  : null;

/** Never send frame props to the v1 prototype: it would silently ignore them. */
export const NativeFrameClimbOverlayGPU: ComponentType<ClimbOverlayGPUFrameProps> | null =
  nativeModule && (nativeModule.apiVersion ?? 1) >= 2
    ? requireNativeViewManager<ClimbOverlayGPUFrameProps>('ClimbOverlayGPU')
    : null;

export const NativeMotionClimbOverlayGPU: ComponentType<ClimbOverlayGPUMotionProps> | null =
  nativeModule && (nativeModule.apiVersion ?? 1) >= 3
    ? requireNativeViewManager<ClimbOverlayGPUMotionProps>('ClimbOverlayGPU')
    : null;
