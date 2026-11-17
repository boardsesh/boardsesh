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
  onRenderError?: (
    event: NativeSyntheticEvent<{
      requestId: string;
      reason: string;
      failureScope?: 'frame' | 'static' | 'context';
    }>,
  ) => void;
};

/** v2 separates immutable layout configuration from the changing climb. */
export type ClimbOverlayGPUFrameProps = ClimbOverlayGPUNativeProps & {
  /** configJson must contain frames: ''; only this prop changes per climb. */
  frames: string;
};

/** v3 keeps the wall fixed while the gesture changes its lit holds. */
export type ClimbOverlayGPUMotionProps = ClimbOverlayGPUFrameProps & {
  previousFrames: string | null;
  nextFrames: string | null;
  centerPage: number;
  /** The wipe's absolute pager position, updated directly from a UI-thread worklet. */
  pagePosition?: number;
  /** API6 only: 'swap' weights hold classes over time; 'wipe' (the default) sweeps by position. */
  revealMode?: 'wipe' | 'swap';
  /**
   * API6 swap only, updated from a UI-thread worklet as one value: the pair (the
   * nearest page is the climb being left, and the side the position leans to
   * holds the arriving one), then the weights of holds lit only in the climb
   * being left and only in the arriving one, each 0 to 1.
   */
  swapFrame?: readonly [pagePosition: number, outgoingWeight: number, incomingWeight: number];
  animateEdits: boolean;
  /** The outer view mirrors artwork; only reverse the reveal direction here. */
  displayMirrored?: boolean;
  reduceMotion: boolean;
  /** API5 only: at most two already-loaded adjacent climbs, prepared while idle. */
  prefetchFrames?: readonly string[];
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

/** Process-cumulative counters, including cancelled and idle preparation work. */
export type ClimbOverlayGPUResourceStats = {
  available: true;
  statsVersion: 1;
  nativeActivityEpoch: number;
  pendingNativeJobs: number;
  pendingGpuCommands: number;
  cpuToGpuPixelUploadBytes: number;
  gpuArenaCopyBytes: number;
  gpuPixelUploadBytes: number;
  prefetchPixelUploadBytes: number;
  arenaReplacements: number;
  contextResets: number;
  gpuReservedBytes: number;
  /** No pending work and a stable activity epoch across the Rust snapshot. */
  drained: boolean;
  rust: {
    available: true;
    version: 1;
    panicGuardEnabled: boolean;
    fieldRasterAttempts: number;
    fieldRasterCompleted: number;
    roleRasterAttempts: number;
    roleRasterCompleted: number;
    cpuFieldMaterializations: number;
    cpuRoleMaterializations: number;
    cpuCacheHits: number;
    localCacheHits: number;
    localCacheCorrupt: number;
    localCacheMisses: number;
    pendingPreparationPhases: number;
    pendingCacheWrites: number;
    activityEpoch: number;
    drained: boolean;
  };
};

const nativeModule = requireOptionalNativeModule<{
  apiVersion?: number;
  compare?(configJson: string): Promise<ClimbOverlayGPUComparison>;
  getResourceStats?(): Promise<ClimbOverlayGPUResourceStats>;
}>('ClimbOverlayGPU');

// A binary can support live rendering without the optional diagnostic readback.
export const compareClimbOverlayGPU =
  nativeModule && typeof nativeModule.compare === 'function' ? nativeModule.compare.bind(nativeModule) : null;

/** Missing on older binaries: callers must report unavailable, never zero work. */
export const getClimbOverlayGPUResourceStats =
  nativeModule && typeof nativeModule.getResourceStats === 'function'
    ? nativeModule.getResourceStats.bind(nativeModule)
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
