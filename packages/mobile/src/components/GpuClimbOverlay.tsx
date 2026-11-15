import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import {
  NativeFrameClimbOverlayGPU,
  NativeMotionClimbOverlayGPU,
  type ClimbOverlayGPUReady,
} from '../../modules/climb-overlay-gpu/src';

export type GpuClimbTransition = {
  previousFrames: string | null;
  nextFrames: string | null;
  centerPage: number;
  pagePosition: SharedValue<number>;
};

const AnimatedMotionOverlay = NativeMotionClimbOverlayGPU
  ? Animated.createAnimatedComponent(NativeMotionClimbOverlayGPU)
  : null;

type Props = {
  configJson: string;
  frames: string;
  requestId: string;
  transition?: GpuClimbTransition;
  animateEdits?: boolean;
  onPresented: (requestId: string) => void;
  onFailure: (requestId: string, configJson: string) => void;
  onReset: (requestId: string) => void;
  onRelease: () => void;
};

/** Mounted only by a visible board stack. API v2 reports drawable presentation. */
export function GpuClimbOverlay({
  configJson,
  frames,
  requestId,
  transition,
  animateEdits = false,
  onPresented,
  onFailure,
  onReset,
  onRelease,
}: Props) {
  const reduceMotion = useReduceMotion();
  const pagePosition = transition?.pagePosition;
  const centerPage = transition?.centerPage ?? 0;
  // Updating this native numeric prop stays on the UI thread. No React render,
  // config serialization or hold-list preparation runs for a drag frame.
  const animatedProps = useAnimatedProps(
    () => ({
      pagePosition: reduceMotion ? centerPage : (pagePosition?.value ?? centerPage),
    }),
    [pagePosition, centerPage, reduceMotion],
  );
  // Clearing the view/config releases its last presented drawable; changing
  // only the request keeps that drawable on screen until the next is ready.
  useLayoutEffect(() => () => onRelease(), [configJson, onRelease]);
  const currentRequest = useRef<string | null>(null);
  const answered = useRef(false);
  const failureReported = useRef(false);
  useLayoutEffect(() => {
    currentRequest.current = requestId;
    answered.current = false;
    failureReported.current = false;
    onReset(requestId);
    return () => {
      currentRequest.current = null;
      onReset(requestId);
    };
  }, [requestId, onReset]);
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (currentRequest.current !== requestId || answered.current) return;
      answered.current = true;
      failureReported.current = true;
      if (__DEV__) console.info('[gpu-climb-live]', JSON.stringify({ requestId, reason: 'presentation-timeout' }));
      onFailure(requestId, configJson);
    }, 10000);
    return () => clearTimeout(timeout);
  }, [requestId, configJson, onFailure]);
  const ready = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<ClimbOverlayGPUReady>) => {
      if (currentRequest.current !== nativeEvent.requestId || answered.current) return;
      answered.current = true;
      if (__DEV__) {
        const { requestId, prepareMs, uploadMs, gpuMs, atlasCacheHit, atlasBytes } = nativeEvent;
        console.info(
          '[gpu-climb-live]',
          JSON.stringify({ requestId, prepareMs, uploadMs, gpuMs, atlasCacheHit, atlasBytes }),
        );
      }
      onPresented(nativeEvent.requestId);
    },
    [onPresented],
  );
  const failed = useCallback(
    ({ nativeEvent }: NativeSyntheticEvent<{ requestId: string; reason: string }>) => {
      if (currentRequest.current !== nativeEvent.requestId || failureReported.current) return;
      answered.current = true;
      failureReported.current = true;
      if (__DEV__) {
        console.info(
          '[gpu-climb-live]',
          JSON.stringify({ requestId: nativeEvent.requestId, reason: nativeEvent.reason }),
        );
      }
      onFailure(nativeEvent.requestId, configJson);
    },
    [onFailure, configJson],
  );
  if (NativeMotionClimbOverlayGPU && AnimatedMotionOverlay) {
    return (
      <AnimatedMotionOverlay
        style={StyleSheet.absoluteFill}
        configJson={configJson}
        frames={frames}
        previousFrames={transition?.previousFrames ?? null}
        nextFrames={transition?.nextFrames ?? null}
        centerPage={centerPage}
        animatedProps={animatedProps}
        animateEdits={animateEdits && !transition}
        reduceMotion={reduceMotion}
        requestId={requestId}
        active
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
      active
      onRenderReady={ready}
      onRenderError={failed}
    />
  );
}
