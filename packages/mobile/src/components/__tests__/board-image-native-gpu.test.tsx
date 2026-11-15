// @vitest-environment jsdom
import React from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  enabled: true,
  nativeAvailable: true,
  motionAvailable: true,
  reduceMotion: false,
  gpuStatus: 'ready' as 'loading' | 'ready',
  animatedWorklet: null as null | (() => { pagePosition: number }),
  hidden: false,
  visibilityListeners: new Set<() => void>(),
  props: null as null | {
    requestId: string;
    frames: string;
    animateEdits?: boolean;
    reduceMotion?: boolean;
    previousFrames?: string | null;
    nextFrames?: string | null;
    centerPage?: number;
    onRenderReady: (event: { nativeEvent: { requestId: string } }) => void;
    onRenderError: (event: { nativeEvent: { requestId: string } }) => void;
  },
  imageDisplays: [] as Array<() => void>,
  hookInputs: [] as Array<{ gpuSurface?: boolean; gpuFallbackConfigJson?: string | null }>,
  pngMounted: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, absoluteFill: {} },
}));
vi.mock('expo-image', () => ({
  Image: ({ source, onDisplay }: { source: { uri: string }; onDisplay?: () => void }) => {
    if (onDisplay) controls.imageDisplays.push(onDisplay);
    return <img alt="board" src={source.uri} />;
  },
}));
vi.mock('../../lib/app-visibility', () => ({
  useIsAppBackgrounded: () =>
    React.useSyncExternalStore(
      (listener) => {
        controls.visibilityListeners.add(listener);
        return () => {
          controls.visibilityListeners.delete(listener);
        };
      },
      () => controls.hidden,
    ),
}));
vi.mock('../board-art-visibility-context', () => ({ useBoardArtVisible: () => true }));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => controls.reduceMotion }));
vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: <Props,>(component: React.ComponentType<Props>) => component },
  useAnimatedProps: (factory: () => { pagePosition: number }) => {
    controls.animatedWorklet = factory;
    return factory();
  },
}));
vi.mock('../../providers/feature-flags-provider', () => ({ useGpuClimbOverlayEnabled: () => controls.enabled }));
vi.mock('../../hooks/use-board-accessibility-summary', () => ({ useBoardAccessibilitySummary: () => 'Board' }));
vi.mock('../board/MoonBoardGridLabels', () => ({ MoonBoardGridLabels: () => null }));
vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
  get NativeMotionClimbOverlayGPU() {
    return controls.nativeAvailable && controls.motionAvailable ? NativeView : null;
  },
  get NativeFrameClimbOverlayGPU() {
    return controls.nativeAvailable ? NativeView : null;
  },
}));
function NativeView(props: NonNullable<typeof controls.props>) {
  controls.props = props;
  return <div data-testid="native-gpu" />;
}
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: (props: { frames: string; gpuSurface?: boolean; gpuFallbackConfigJson?: string | null }) => {
    controls.hookInputs.push(props);
    const gpu =
      props.gpuSurface &&
      props.gpuFallbackConfigJson !== 'static-config' &&
      props.frames !== '' &&
      controls.gpuStatus === 'ready';
    return {
      gpuConfigJson: gpu ? 'static-config' : null,
      gpuStatus: controls.gpuStatus === 'loading' ? 'loading' : gpu ? 'ready' : 'unavailable',
      gpuFrames: props.frames,
      overlayUri: props.frames ? 'file:///cached-overlay.png' : null,
      overlayLoadKey: 'cached',
      overlayUnavailable: false,
      overlayFailed: false,
      overlayImmediate: true,
      onOverlayLoad: vi.fn(),
      onOverlayError: vi.fn(),
      onOverlayMounted: controls.pngMounted,
      backgroundPaths: ['/board.jpg'],
      missingBackgroundCount: 0,
      rendererUnavailable: false,
      artworkIdentity: {
        boardName: 'kilter',
        layoutId: 8,
        sizeId: 25,
        setIds: '26,27,28,29',
        frames: props.frames,
        renderSignature: 'aura',
        colorScheme: 'dark',
      },
    };
  },
}));
import { BoardImageNative } from '../BoardImageNative';
const BOARD = {
  boardName: 'kilter' as const,
  layoutId: 8,
  sizeId: 25,
  setIds: '26,27,28,29',
  boardWidth: 1080,
  boardHeight: 1504,
  frames: 'p4131r42',
  playSurface: true,
};

describe('live GPU board integration', () => {
  beforeEach(() => {
    controls.enabled = true;
    controls.nativeAvailable = true;
    controls.motionAvailable = true;
    controls.reduceMotion = false;
    controls.gpuStatus = 'ready';
    controls.animatedWorklet = null;
    controls.hidden = false;
    controls.props = null;
    controls.imageDisplays = [];
    controls.hookInputs = [];
    controls.pngMounted.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps incoming cached art until GPU and photos display, without publishing a PNG handoff', () => {
    const handoff = vi.fn();
    const readiness = vi.fn();
    render(<BoardImageNative {...BOARD} onReadyArtDisplayed={handoff} onArtReadinessChange={readiness} />);
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).not.toBeNull();
    expect(controls.pngMounted.mock.calls.every(([key]) => key === null)).toBe(true);
    act(() => {
      controls.imageDisplays.forEach((display) => display());
    });
    expect(readiness).not.toHaveBeenLastCalledWith('ready');
    const current = controls.props!;
    act(() => current.onRenderReady({ nativeEvent: { requestId: current.requestId } }));
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).toBeNull();
    expect(readiness).toHaveBeenLastCalledWith('ready');
    expect(handoff).not.toHaveBeenCalled();
  });

  it('uses a new generation on A-B-A and clears an empty editor immediately', () => {
    const { rerender } = render(<BoardImageNative {...BOARD} playSurface={false} editorSurface />);
    const original = controls.props!;
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface frames="p4306r43" />);
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface />);
    expect(controls.props!.requestId).not.toBe(original.requestId);
    act(() => original.onRenderError({ nativeEvent: { requestId: original.requestId } }));
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface frames="" />);
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).toBeNull();
  });

  it.each(['flag', 'binary', 'thumbnail', 'inactive'] as const)('keeps PNG rendering for %s', (reason) => {
    controls.enabled = reason !== 'flag';
    controls.nativeAvailable = reason !== 'binary';
    render(<BoardImageNative {...BOARD} filledStyle={reason === 'thumbnail'} playSurface={reason !== 'inactive'} />);
    expect(controls.hookInputs.at(-1)?.gpuSurface).toBe(false);
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).not.toBeNull();
  });

  it('passes editor settling only to v3 and respects Reduce Motion', () => {
    const { rerender } = render(<BoardImageNative {...BOARD} playSurface={false} editorSurface />);
    expect(controls.props?.animateEdits).toBe(true);
    expect(controls.props?.reduceMotion).toBe(false);
    controls.reduceMotion = true;
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface frames="p4306r43" />);
    expect(controls.props?.reduceMotion).toBe(true);
    controls.motionAvailable = false;
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface frames="p4131r43" />);
    expect(controls.props?.animateEdits).toBeUndefined();
  });

  it('updates transition progress on the UI worklet and rejects stale neighbor readiness', () => {
    const state = vi.fn();
    const pagePosition = { value: 4 } as SharedValue<number>;
    const transition = { previousFrames: 'p4131r43', nextFrames: 'p4306r43', centerPage: 4, pagePosition };
    const { rerender } = render(
      <BoardImageNative {...BOARD} gpuTransition={transition} onGpuTransitionStateChange={state} />,
    );
    const first = controls.props!;
    expect(first.previousFrames).toBe(transition.previousFrames);
    expect(first.nextFrames).toBe(transition.nextFrames);
    expect(first.animateEdits).toBe(false);
    expect(state).toHaveBeenLastCalledWith('loading');
    const renderCount = controls.hookInputs.length;
    pagePosition.value = 4.75;
    expect(controls.animatedWorklet?.().pagePosition).toBe(4.75);
    expect(controls.hookInputs).toHaveLength(renderCount);
    act(() => first.onRenderReady({ nativeEvent: { requestId: first.requestId } }));
    expect(state).toHaveBeenLastCalledWith('ready');
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).toBeNull();
    rerender(
      <BoardImageNative
        {...BOARD}
        gpuTransition={{ ...transition, nextFrames: 'p4306r42' }}
        onGpuTransitionStateChange={state}
      />,
    );
    expect(controls.props!.requestId).not.toBe(first.requestId);
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).toBeNull();
    expect(state).toHaveBeenLastCalledWith('loading');
    act(() => first.onRenderReady({ nativeEvent: { requestId: first.requestId } }));
    expect(state).toHaveBeenLastCalledWith('loading');
    controls.reduceMotion = true;
    rerender(
      <BoardImageNative {...BOARD} frames="p4131r43" gpuTransition={transition} onGpuTransitionStateChange={state} />,
    );
    expect(controls.animatedWorklet?.().pagePosition).toBe(4);
  });

  it('flattens multi-frame neighboring climbs just like the current climb', () => {
    const transition = {
      previousFrames: 'p4131r42,p4306r43',
      nextFrames: 'p4131r43,p4306r45',
      centerPage: 0,
      pagePosition: { value: 0 } as SharedValue<number>,
    };
    render(<BoardImageNative {...BOARD} gpuTransition={transition} />);
    expect(controls.props?.previousFrames).toBe('p4131r42p4306r43');
    expect(controls.props?.nextFrames).toBe('p4131r43p4306r45');
  });

  it('keeps a stationary attempt loading until geometry discovery finishes', () => {
    controls.gpuStatus = 'loading';
    const state = vi.fn();
    const transition = {
      previousFrames: null,
      nextFrames: 'p4306r43',
      centerPage: 0,
      pagePosition: { value: 0 } as SharedValue<number>,
    };
    const { rerender } = render(
      <BoardImageNative {...BOARD} gpuTransition={transition} onGpuTransitionStateChange={state} />,
    );
    expect(state).toHaveBeenLastCalledWith('loading');
    expect(state).not.toHaveBeenCalledWith('unavailable');
    controls.gpuStatus = 'ready';
    rerender(
      <BoardImageNative {...BOARD} frames="p4131r43" gpuTransition={transition} onGpuTransitionStateChange={state} />,
    );
    const current = controls.props!;
    act(() => current.onRenderReady({ nativeEvent: { requestId: current.requestId } }));
    expect(state).toHaveBeenLastCalledWith('ready');
  });

  it('reports stationary transitions unavailable on a v2 binary', () => {
    controls.motionAvailable = false;
    const state = vi.fn();
    const transition = {
      previousFrames: null,
      nextFrames: 'p4306r43',
      centerPage: 0,
      pagePosition: { value: 0 } as SharedValue<number>,
    };
    render(<BoardImageNative {...BOARD} gpuTransition={transition} onGpuTransitionStateChange={state} />);
    expect(state).toHaveBeenLastCalledWith('unavailable');
    expect(controls.hookInputs.at(-1)?.gpuSurface).toBe(false);
    expect(screen.queryByTestId('native-gpu')).toBeNull();
  });

  it('falls back after a silent foreground renderer and cancels its watch while hidden', () => {
    vi.useFakeTimers();
    render(<BoardImageNative {...BOARD} />);
    act(() => {
      controls.hidden = true;
      controls.visibilityListeners.forEach((listener) => listener());
    });
    act(() => {
      vi.advanceTimersByTime(11000);
    });
    expect(controls.hookInputs.at(-1)?.gpuFallbackConfigJson).toBeNull();
    act(() => {
      controls.hidden = false;
      controls.visibilityListeners.forEach((listener) => listener());
    });
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(controls.hookInputs.at(-1)?.gpuFallbackConfigJson).toBe('static-config');
    expect(screen.queryByTestId('native-gpu')).toBeNull();
  });
});
