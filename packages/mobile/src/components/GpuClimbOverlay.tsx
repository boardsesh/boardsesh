import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, type NativeSyntheticEvent } from 'react-native';
import { NativeFrameClimbOverlayGPU, type ClimbOverlayGPUReady } from '../../modules/climb-overlay-gpu/src';

type Props = {
  configJson: string;
  frames: string;
  requestId: string;
  onPresented: (requestId: string) => void;
  onFailure: (requestId: string, configJson: string) => void;
  onReset: (requestId: string) => void;
};

/** Mounted only by a visible board stack. API v2 reports drawable presentation. */
export function GpuClimbOverlay({ configJson, frames, requestId, onPresented, onFailure, onReset }: Props) {
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
