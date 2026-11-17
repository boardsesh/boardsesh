import {
  climbOverlayGpuApiVersion,
  type ClimbOverlayGPUFailure,
  type ClimbOverlayGPUFailureScope,
} from '../lib/board-render/gpu-native-capability';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { useIsAppActive, isAppActiveNow } from '../lib/app-visibility';
import {
  NativeFrameClimbOverlayGPU,
  NativeMotionClimbOverlayGPU,
  type ClimbOverlayGPUReady,
} from '../../modules/climb-overlay-gpu/src';
import {
  nativeWallSwapFrame,
  WALL_SWAP_NATIVE_API,
  type NativeWallSwapFrame,
  type RevealMode,
  type WallSwapFrame,
} from './play-drawer/wall-swap';
import {
  classifyGpuFallback,
  reportGpuFallback,
  reportGpuPreparation,
  resolveGpuFailureScope,
  type GpuFallbackReason,
} from '../lib/board-render/gpu-telemetry';

export type GpuClimbTransition = {
  previousFrames: string | null;
  nextFrames: string | null;
  centerPage: number;
  /** The pager's position, which the wipe follows. */
  pagePosition: SharedValue<number>;
  prefetchFrames?: readonly string[];
  /** API 6: the swap weights hold classes over time instead of wiping by position. */
  revealMode?: RevealMode;
  /** The swap's pair and three weights, one value (see play-drawer/wall-swap). */
  swapFrame?: SharedValue<WallSwapFrame>;
};

const NO_GPU_PREFETCH_FRAMES: readonly string[] = [];

const AnimatedMotionOverlay = NativeMotionClimbOverlayGPU
  ? Animated.createAnimatedComponent(NativeMotionClimbOverlayGPU)
  : null;

type Props = {
  configJson: string;
  frames: string;
  requestId: string;
  boardName?: string;
  transition?: GpuClimbTransition;
  animateEdits?: boolean;
  displayMirrored?: boolean;
  onPresented: (requestId: string, configJson: string) => void;
  onFailure: (
    requestId: string,
    configJson: string,
    reason: GpuFallbackReason,
    failureScope: ClimbOverlayGPUFailureScope,
  ) => void;
  onReset: (requestId: string) => void;
  onRelease: () => void;
};

/** Mounted only by a visible board stack. API v2 reports drawable presentation. */
export function GpuClimbOverlay({
  configJson,
  frames,
  requestId,
  boardName = 'unknown',
  transition,
  animateEdits = false,
  displayMirrored = false,
  onPresented,
  onFailure,
  onReset,
  onRelease,
}: Props) {
  const reduceMotion = useReduceMotion();
  const appActive = useIsAppActive();
  const pagePosition = transition?.pagePosition;
  const centerPage = transition?.centerPage ?? 0;
  const swapFrame = transition?.swapFrame;
  // The swap handles Reduce Motion itself, as a shorter dissolve; the wipe stops.
  const swap =
    transition?.revealMode === 'swap' && swapFrame !== undefined && climbOverlayGpuApiVersion >= WALL_SWAP_NATIVE_API;
  // Updating these native numeric props stays on the UI thread. No React render,
  // config serialization or hold-list preparation runs for a drag frame.
  const animatedProps = useAnimatedProps(
    (): { pagePosition?: number; swapFrame?: NativeWallSwapFrame } =>
      swap && swapFrame
        ? { swapFrame: nativeWallSwapFrame(swapFrame.value, climbOverlayGpuApiVersion) }
        : { pagePosition: reduceMotion ? centerPage : (pagePosition?.value ?? centerPage) },
    [pagePosition, centerPage, reduceMotion, swap, swapFrame],
  );
  // Clearing the view/config releases its last presented drawable; changing
  // only the request keeps that drawable on screen until the next is ready.
  useLayoutEffect(() => () => onRelease(), [configJson, onRelease]);
  const currentRequest = useRef<string | null>(null);
  const answered = useRef(false);
  const failureReported = useRef(false);
  useLayoutEffect(() => {
    currentRequest.current = appActive ? requestId : null;
    answered.current = false;
    failureReported.current = false;
    onReset(requestId);
    return () => {
      currentRequest.current = null;
      onReset(requestId);
    };
  }, [requestId, onReset, appActive]);
  useEffect(() => {
    if (!appActive) return;
    // A missed deadline says this phone was slow or the view left the screen,
    // not that the config is broken. Fall back for these frames on this mount
    // only; the next frames try the GPU again.
    const timeout = setTimeout(() => {
      if (!isAppActiveNow() || currentRequest.current !== requestId || answered.current) return;
      answered.current = true;
      failureReported.current = true;
      if (__DEV__) console.info('[gpu-climb-live]', JSON.stringify({ requestId, reason: 'presentation-timeout' }));
      reportGpuFallback(
        { boardName, apiVersion: climbOverlayGpuApiVersion, surface: animateEdits ? 'editor' : 'player' },
        requestId,
        'presentation-timeout',
        'context',
      );
      onFailure(requestId, configJson, 'presentation-timeout', 'context');
    }, 10000);
    return () => clearTimeout(timeout);
  }, [requestId, configJson, onFailure, boardName, animateEdits, appActive]);
  const ready = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ClimbOverlayGPUReady>) => {
      if (!isAppActiveNow() || currentRequest.current !== nativeEvent.requestId || answered.current) return;
      answered.current = true;
      reportGpuPreparation(
        { boardName, apiVersion: climbOverlayGpuApiVersion, surface: animateEdits ? 'editor' : 'player' },
        nativeEvent,
      );
      if (__DEV__) {
        const {
          requestId,
          prepareMs,
          uploadMs,
          gpuMs,
          atlasCacheHit,
          atlasBytes,
          editChangedHoldCount,
          editDurationMs,
          lowPowerMode,
        } = nativeEvent;
        console.info(
          '[gpu-climb-live]',
          JSON.stringify({
            requestId,
            prepareMs,
            uploadMs,
            gpuMs,
            atlasCacheHit,
            atlasBytes,
            editChangedHoldCount,
            editDurationMs,
            lowPowerMode,
            surface: animateEdits ? 'editor' : 'player',
            apiVersion: climbOverlayGpuApiVersion,
            reduceMotion,
          }),
        );
      }
      onPresented(nativeEvent.requestId, configJson);
    },
    [onPresented, configJson, animateEdits, reduceMotion, boardName],
  );
  const failed = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ClimbOverlayGPUFailure>) => {
      if (!isAppActiveNow() || currentRequest.current !== nativeEvent.requestId || failureReported.current) return;
      const reason = classifyGpuFallback(nativeEvent.reason);
      if (reason === 'cancelled') return;
      answered.current = true;
      failureReported.current = true;
      const failureScope = resolveGpuFailureScope(nativeEvent.failureScope, nativeEvent.reason, reason);
      if (__DEV__) {
        console.info(
          '[gpu-climb-live]',
          JSON.stringify({ requestId: nativeEvent.requestId, reason: nativeEvent.reason }),
        );
      }
      reportGpuFallback(
        { boardName, apiVersion: climbOverlayGpuApiVersion, surface: animateEdits ? 'editor' : 'player' },
        nativeEvent.requestId,
        reason,
        failureScope,
      );
      onFailure(nativeEvent.requestId, configJson, reason, failureScope);
    },
    [onFailure, configJson, boardName, animateEdits],
  );
  if (NativeMotionClimbOverlayGPU && AnimatedMotionOverlay) {
    return (
      <AnimatedMotionOverlay
        style={StyleSheet.absoluteFill}
        configJson={configJson}
        frames={frames}
        previousFrames={transition?.previousFrames ?? null}
        nextFrames={transition?.nextFrames ?? null}
        {...(climbOverlayGpuApiVersion >= 5
          ? { prefetchFrames: transition?.prefetchFrames ?? NO_GPU_PREFETCH_FRAMES }
          : {})}
        {...(climbOverlayGpuApiVersion >= WALL_SWAP_NATIVE_API ? { revealMode: swap ? 'swap' : 'wipe' } : {})}
        centerPage={centerPage}
        animatedProps={animatedProps}
        animateEdits={animateEdits && !transition}
        reduceMotion={reduceMotion}
        displayMirrored={displayMirrored}
        requestId={requestId}
        active={appActive}
        onRenderReady={ready}
        onRenderError={failed}
      />
    );
  }
  if (!NativeFrameClimbOverlayGPU) return null;
  return (
    <NativeFrameClimbOverlayGPU
      style={StyleSheet.absoluteFill}
      configJson={configJson}
      frames={frames}
      requestId={requestId}
      active={appActive}
      onRenderReady={ready}
      onRenderError={failed}
    />
  );
}
