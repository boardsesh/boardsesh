import {
  climbOverlayGpuApiVersion,
  climbOverlaySwapCommandApi,
  climbOverlaySwapLookProbe,
  climbOverlaySwapLookVersion,
  type ClimbOverlayGPUFailure,
  type ClimbOverlayGPUFailureScope,
} from '../lib/board-render/gpu-native-capability';
import { noteSwapLookProbe } from '../lib/board-render/swap-look-probe';
import { useCallback, useEffect, useLayoutEffect, useRef, type Component, type FunctionComponent } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { useIsAppActive, isAppActiveNow } from '../lib/app-visibility';
import {
  NativeFrameClimbOverlayGPU,
  NativeMotionClimbOverlayGPU,
  type ClimbOverlayGPUMotionProps,
  type ClimbOverlayGPUReady,
  type ClimbOverlayGPUSwapLookState,
} from '../../modules/climb-overlay-gpu/src';
import {
  nativeWallSwapFrame,
  WALL_SWAP_NATIVE_API,
  type NativeWallSwapFrame,
  type RevealMode,
} from './play-drawer/wall-swap';
import {
  shippedSwapFrame,
  SWAP_LOOK_NATIVE_VERSION,
  type SwapFrameSource,
  type SwapLookStatus,
} from './play-drawer/swap-look';
import {
  INITIAL_SWAP_FRAME_SEQUENCE,
  sequencedSwapFrame,
  useSwapFrameCommand,
  type SequencedSwapFrame,
} from './play-drawer/use-swap-frame-command';
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
  /** The swap's pair and three weights, one value (see play-drawer/wall-swap), or a swap-look frame. */
  swapFrame?: SwapFrameSource;
  /** The encoded swap look (`encodeSwapLook`) its six-number frames are drawn with: the player's or the lab's. */
  swapLook?: readonly number[];
  /**
   * Board motion lab only: the native look's state, when it changes. Without it
   * the view is never asked for the event (`swapLookStateEvents`).
   */
  onSwapLookState?: (status: SwapLookStatus) => void;
  /** Board motion lab only: Reduce Motion as it chose; absent, the system setting. */
  reduceMotion?: boolean;
  /** Board motion lab only: this board presented a request, with the native timings. */
  onRenderReady?: (ready: ClimbOverlayGPUReady) => void;
  /** Board motion lab only: this board gave up on a request; the native reason. */
  onRenderError?: (reason: string) => void;
};

const NO_GPU_PREFETCH_FRAMES: readonly string[] = [];

/** The native look event as a status, or null for a payload this app does not know. */
function swapLookStatus(event: ClimbOverlayGPUSwapLookState): SwapLookStatus | null {
  const reachOff = typeof event.reachOff === 'string' ? { reachOff: event.reachOff } : {};
  if (event.state === 'off') return { state: 'off', reason: event.reason ?? 'unknown' };
  if (event.state === 'ready') return { state: 'ready', ...reachOff };
  if (event.state === 'on' && typeof event.holds === 'number') return { state: 'on', holds: event.holds, ...reachOff };
  return null;
}

/** What a ref on the animated motion overlay receives: the swap command's target. */
type MotionOverlayInstance = Component<ClimbOverlayGPUMotionProps> | FunctionComponent<ClimbOverlayGPUMotionProps>;

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
  // Earlier Android binaries only: retain their startup-probe diagnostic breadcrumb.
  useEffect(() => noteSwapLookProbe(climbOverlaySwapLookProbe), []);
  const systemReduceMotion = useReduceMotion();
  const reduceMotion = transition?.reduceMotion ?? systemReduceMotion;
  const onTransitionReady = transition?.onRenderReady;
  const onTransitionError = transition?.onRenderError;
  const onTransitionLook = transition?.onSwapLookState;
  const appActive = useIsAppActive();
  const pagePosition = transition?.pagePosition;
  const centerPage = transition?.centerPage ?? 0;
  const swapFrame = transition?.swapFrame;
  // The swap handles Reduce Motion itself, as a shorter dissolve; the wipe stops.
  const swap =
    transition?.revealMode === 'swap' && swapFrame !== undefined && climbOverlayGpuApiVersion >= WALL_SWAP_NATIVE_API;
  // #7737: a binary that advertises the command takes each swap frame as a view
  // command, which a React commit cannot hold back. The animated prop still
  // carries the frame, with the same sequence, for mount and as a backstop.
  const swapCommand = swap && AnimatedMotionOverlay !== null && climbOverlaySwapCommandApi >= 1;
  // A binary with the swap look takes its six-number frames (seven with the
  // sequence) and the look itself; any other binary gets the shipped four
  // numbers and no look, and draws API 7's swap. The player only sends a look
  // where this holds (`binaryDrawsPlayerSwapLook`).
  const swapLookSupported = swapCommand && climbOverlaySwapLookVersion >= SWAP_LOOK_NATIVE_VERSION;
  const swapLook = swapLookSupported ? transition?.swapLook : undefined;
  const swapLookState = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ClimbOverlayGPUSwapLookState>) => {
      const status = swapLookStatus(nativeEvent);
      if (status) onTransitionLook?.(status);
    },
    [onTransitionLook],
  );
  const { target: swapCommandTarget, latest: latestSequencedFrame } = useSwapFrameCommand<MotionOverlayInstance>(
    swapFrame,
    swapCommand,
    swapLookSupported,
  );
  // Updating these native numeric props stays on the UI thread. No React render,
  // config serialization or hold-list preparation runs for a drag frame.
  const animatedProps = useAnimatedProps((): {
    pagePosition?: number;
    swapFrame?: NativeWallSwapFrame | SequencedSwapFrame;
  } => {
    if (!swap || !swapFrame) return { pagePosition: reduceMotion ? centerPage : (pagePosition?.value ?? centerPage) };
    if (!swapCommand) {
      return { swapFrame: nativeWallSwapFrame(shippedSwapFrame(swapFrame.value), climbOverlayGpuApiVersion) };
    }
    // Before the UI thread's first frame, the frame on hand with the lowest sequence.
    const frame = swapLookSupported ? swapFrame.value : shippedSwapFrame(swapFrame.value);
    return { swapFrame: latestSequencedFrame.value ?? sequencedSwapFrame(frame, INITIAL_SWAP_FRAME_SEQUENCE) };
  }, [pagePosition, centerPage, reduceMotion, swap, swapCommand, swapLookSupported, swapFrame, latestSequencedFrame]);
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
      onTransitionError?.('presentation-timeout');
      reportGpuFallback(
        { boardName, apiVersion: climbOverlayGpuApiVersion, surface: animateEdits ? 'editor' : 'player' },
        requestId,
        'presentation-timeout',
        'context',
      );
      onFailure(requestId, configJson, 'presentation-timeout', 'context');
    }, 10000);
    return () => clearTimeout(timeout);
  }, [requestId, configJson, onFailure, boardName, animateEdits, appActive, onTransitionError]);
  const ready = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ClimbOverlayGPUReady>) => {
      if (!isAppActiveNow() || currentRequest.current !== nativeEvent.requestId || answered.current) return;
      answered.current = true;
      reportGpuPreparation(
        { boardName, apiVersion: climbOverlayGpuApiVersion, surface: animateEdits ? 'editor' : 'player' },
        nativeEvent,
      );
      onTransitionReady?.(nativeEvent);
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
    [onPresented, configJson, animateEdits, reduceMotion, boardName, onTransitionReady],
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
      onTransitionError?.(nativeEvent.reason);
      onFailure(nativeEvent.requestId, configJson, reason, failureScope);
    },
    [onFailure, configJson, boardName, animateEdits, onTransitionError],
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
        {...(climbOverlaySwapLookVersion >= SWAP_LOOK_NATIVE_VERSION
          ? {
              // Explicitly clear a previously mounted look when its gate closes.
              swapLook: swapLook ?? null,
              swapLookStateEvents: onTransitionLook !== undefined,
              ...(onTransitionLook ? { onSwapLookState: swapLookState } : {}),
            }
          : {})}
        centerPage={centerPage}
        ref={swapCommandTarget}
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
