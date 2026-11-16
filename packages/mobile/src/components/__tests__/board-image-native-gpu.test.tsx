// @vitest-environment jsdom
import React from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'android',
  enabled: true,
  nativeAvailable: true,
  motionAvailable: true,
  reduceMotion: false,
  gpuStatus: 'ready' as 'loading' | 'ready',
  animatedWorklet: null as null | (() => { pagePosition: number }),
  hidden: false,
  active: true,
  visibilityListeners: new Set<() => void>(),
  props: null as null | {
    requestId: string;
    frames: string;
    animateEdits?: boolean;
    displayMirrored?: boolean;
    configJson: string;
    reduceMotion?: boolean;
    previousFrames?: string | null;
    nextFrames?: string | null;
    centerPage?: number;
    onRenderReady: (event: { nativeEvent: { requestId: string } }) => void;
    onRenderError: (event: {
      nativeEvent: { requestId: string; reason?: string; failureScope?: 'frame' | 'static' | 'context' };
    }) => void;
  },
  imageDisplays: [] as Array<() => void>,
  hookInputs: [] as Array<{
    gpuSurface?: boolean;
    gpuAllowEmpty?: boolean;
    gpuFallbackConfigJson?: string | null;
    fieldColorOverride?: string;
  }>,
  pngMounted: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return controls.platform;
    },
  },
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
  isAppActiveNow: () => controls.active && !controls.hidden,
  useIsAppActive: () =>
    React.useSyncExternalStore(
      (listener) => {
        controls.visibilityListeners.add(listener);
        return () => {
          controls.visibilityListeners.delete(listener);
        };
      },
      () => controls.active && !controls.hidden,
    ),
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
vi.mock('../../lib/board-render/gpu-native-capability', () => ({ climbOverlayGpuApiVersion: 5 }));
vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
  climbOverlayGpuApiVersion: 5,
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
vi.mock('../../lib/board-render/gpu-failure-store', () => ({ recordGpuConfigFailure: controls.recordFailure }));
vi.mock('../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: (props: {
    frames: string;
    gpuSurface?: boolean;
    gpuAllowEmpty?: boolean;
    gpuFallbackConfigJson?: string | null;
    fieldColorOverride?: string;
  }) => {
    controls.hookInputs.push(props);
    const gpu =
      props.gpuSurface &&
      props.gpuFallbackConfigJson !== 'static-config' &&
      (props.frames !== '' || props.gpuAllowEmpty) &&
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
        renderSignature: props.fieldColorOverride ? `aura.field-${props.fieldColorOverride}` : 'aura',
        colorScheme: 'dark',
      },
    };
  },
}));
import { BoardImageNative } from '../BoardImageNative';
import { cacheRenderedOverlay } from '../../lib/overlay-index';
import { captureReadyBoardArt } from '../../lib/board-render/ready-board-art';
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

describe.each(['ios', 'android'] as const)('%s live GPU board integration', (platform) => {
  beforeEach(() => {
    controls.platform = platform;
    controls.enabled = true;
    controls.nativeAvailable = true;
    controls.motionAvailable = true;
    controls.reduceMotion = false;
    controls.gpuStatus = 'ready';
    controls.animatedWorklet = null;
    controls.hidden = false;
    controls.active = true;
    controls.props = null;
    controls.imageDisplays = [];
    controls.hookInputs = [];
    controls.pngMounted.mockClear();
    controls.recordFailure.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('forwards the host ground and rejects a full opening snapshot from another surface', () => {
    const cached = cacheRenderedOverlay('old-player-ground', 'file:///old-ground.png');
    const opening = captureReadyBoardArt({
      ...BOARD,
      renderSignature: 'aura',
      colorScheme: 'dark',
      climbUuid: 'real-climb',
      mirrored: false,
      quality: 'full',
      overlayCacheKey: 'old-player-ground',
      overlayUri: cached.uri,
      overlayGeneration: cached.generation,
      overlayLoadKey: `${cached.generation}:0`,
      backgroundPaths: ['/board.jpg'],
    });
    render(<BoardImageNative {...BOARD} readyBoardArt={opening} fieldColorOverride="#1C1C1E" />);
    expect(controls.hookInputs.at(-1)?.fieldColorOverride).toBe('#1C1C1E');
    expect(document.querySelector('img[src="file:///old-ground.png"]')).toBeNull();
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

  it.each(['loading', 'ready'] as const)('never shows a filled thumbnail opening bridge while GPU is %s', (status) => {
    controls.gpuStatus = status;
    const cached = cacheRenderedOverlay(`gpu-opening-thumb-${status}`, 'file:///filled-thumbnail.png');
    const opening = captureReadyBoardArt({
      ...BOARD,
      renderSignature: 'aura',
      colorScheme: 'dark',
      climbUuid: 'real-climb',
      mirrored: false,
      quality: 'thumbnail',
      overlayCacheKey: `gpu-opening-thumb-${status}`,
      overlayUri: cached.uri,
      overlayGeneration: cached.generation,
      overlayLoadKey: `${cached.generation}:0`,
      backgroundPaths: ['/board.jpg'],
    });
    render(<BoardImageNative {...BOARD} readyBoardArt={opening} />);
    expect(document.querySelector('img[src="file:///filled-thumbnail.png"]')).toBeNull();
  });

  it('retains an exact full-style opening bridge until GPU and photos are ready', () => {
    const cached = cacheRenderedOverlay('gpu-opening-full', 'file:///full-style.png');
    const opening = captureReadyBoardArt({
      ...BOARD,
      renderSignature: 'aura',
      colorScheme: 'dark',
      climbUuid: 'real-climb',
      mirrored: false,
      quality: 'full',
      overlayCacheKey: 'gpu-opening-full',
      overlayUri: cached.uri,
      overlayGeneration: cached.generation,
      overlayLoadKey: `${cached.generation}:0`,
      backgroundPaths: ['/board.jpg'],
    });
    render(<BoardImageNative {...BOARD} readyBoardArt={opening} />);
    expect(document.querySelector('img[src="file:///full-style.png"]')).not.toBeNull();
    const current = controls.props!;
    act(() => current.onRenderReady({ nativeEvent: { requestId: current.requestId } }));
    expect(document.querySelector('img[src="file:///full-style.png"]')).not.toBeNull();
    act(() => {
      controls.imageDisplays.forEach((display) => display());
    });
    expect(document.querySelector('img[src="file:///full-style.png"]')).toBeNull();
  });

  it('keeps a v3 empty editor mounted for the first hold and clearing, while v2 still unmounts', () => {
    const { rerender } = render(<BoardImageNative {...BOARD} frames="" playSurface={false} editorSurface />);
    const nativeNode = screen.getByTestId('native-gpu');
    expect(controls.props?.frames).toBe('');
    expect(controls.props?.animateEdits).toBe(true);
    rerender(<BoardImageNative {...BOARD} playSurface={false} editorSurface />);
    expect(screen.getByTestId('native-gpu')).toBe(nativeNode);
    expect(controls.props?.frames).toBe(BOARD.frames);
    rerender(<BoardImageNative {...BOARD} frames="" playSurface={false} editorSurface />);
    expect(screen.getByTestId('native-gpu')).toBe(nativeNode);
    expect(controls.props?.frames).toBe('');
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).toBeNull();
    controls.motionAvailable = false;
    rerender(<BoardImageNative {...BOARD} frames="" playSurface={false} editorSurface style={{ opacity: 1 }} />);
    expect(screen.queryByTestId('native-gpu')).toBeNull();
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
    expect(screen.queryByTestId('native-gpu')).not.toBeNull();
    expect(controls.props?.frames).toBe('');
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

  it('forwards display mirroring without changing the atlas config or request', () => {
    const { rerender } = render(<BoardImageNative {...BOARD} />);
    const initial = controls.props!;
    expect(initial.displayMirrored).toBe(false);
    rerender(<BoardImageNative {...BOARD} mirrored />);
    expect(controls.props?.displayMirrored).toBe(true);
    expect(controls.props?.configJson).toBe(initial.configJson);
    expect(controls.props?.requestId).toBe(initial.requestId);
    rerender(<BoardImageNative {...BOARD} mirrored={false} />);
    expect(controls.props?.displayMirrored).toBe(false);
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
    act(() => {
      controls.imageDisplays.forEach((display) => display());
    });
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

  it('ignores stale ready and error events, then falls back for the current native error', () => {
    const readiness = vi.fn();
    const { rerender } = render(<BoardImageNative {...BOARD} onArtReadinessChange={readiness} />);
    const old = controls.props!;
    rerender(<BoardImageNative {...BOARD} frames="p4306r43" onArtReadinessChange={readiness} />);
    const current = controls.props!;
    expect(current.requestId).not.toBe(old.requestId);
    act(() => {
      old.onRenderReady({ nativeEvent: { requestId: old.requestId } });
      old.onRenderError({ nativeEvent: { requestId: old.requestId } });
    });
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    expect(controls.hookInputs.at(-1)?.gpuFallbackConfigJson).toBeNull();
    expect(readiness).not.toHaveBeenLastCalledWith('ready');
    act(() => current.onRenderError({ nativeEvent: { requestId: current.requestId } }));
    expect(controls.hookInputs.at(-1)?.gpuFallbackConfigJson).toBe('static-config');
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(document.querySelector('img[src="file:///cached-overlay.png"]')).not.toBeNull();
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

  it('ignores cancelled native work and errors from a killed view', () => {
    const { rerender } = render(<BoardImageNative {...BOARD} />);
    const old = controls.props!;
    act(() => old.onRenderError({ nativeEvent: { requestId: old.requestId, reason: 'preparation cancelled' } }));
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    expect(controls.recordFailure).not.toHaveBeenCalled();
    controls.enabled = false;
    rerender(<BoardImageNative {...BOARD} style={{ opacity: 1 }} />);
    act(() =>
      old.onRenderError({ nativeEvent: { requestId: old.requestId, reason: 'atlas failed', failureScope: 'static' } }),
    );
    expect(controls.recordFailure).not.toHaveBeenCalled();
    expect(screen.queryByTestId('native-gpu')).toBeNull();
  });

  it.each(['frame', 'context'] as const)('keeps %s errors local to the current frames', (failureScope) => {
    const { rerender } = render(<BoardImageNative {...BOARD} />);
    const current = controls.props!;
    act(() =>
      current.onRenderError({ nativeEvent: { requestId: current.requestId, reason: 'render failed', failureScope } }),
    );
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(controls.recordFailure).not.toHaveBeenCalled();
    rerender(<BoardImageNative {...BOARD} frames="p4306r43" />);
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
  });

  it('persists only a terminal static failure', () => {
    render(<BoardImageNative {...BOARD} />);
    const current = controls.props!;
    act(() =>
      current.onRenderError({
        nativeEvent: { requestId: current.requestId, reason: 'GPU budget exceeded', failureScope: 'static' },
      }),
    );
    expect(controls.recordFailure).toHaveBeenCalledExactlyOnceWith('static-config', 5);
    expect(screen.queryByTestId('native-gpu')).toBeNull();
  });

  it('restarts the presentation deadline after an interruption without persisting a failure', () => {
    vi.useFakeTimers();
    render(<BoardImageNative {...BOARD} />);
    act(() => {
      controls.active = false;
      controls.visibilityListeners.forEach((listener) => listener());
      vi.advanceTimersByTime(11_000);
    });
    expect(controls.recordFailure).not.toHaveBeenCalled();
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    act(() => {
      controls.active = true;
      controls.visibilityListeners.forEach((listener) => listener());
    });
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(controls.recordFailure).not.toHaveBeenCalled();
  });

  it('keeps a presentation timeout on this mount and tries the GPU again for the next climb', () => {
    vi.useFakeTimers();
    const { rerender } = render(<BoardImageNative {...BOARD} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(controls.hookInputs.at(-1)?.gpuFallbackConfigJson).toBe('static-config');
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(controls.recordFailure).not.toHaveBeenCalled();
    rerender(<BoardImageNative {...BOARD} frames="p4306r43" />);
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
    expect(controls.recordFailure).not.toHaveBeenCalled();
  });

  it.each([
    'GPU command encoding unavailable',
    'GPU Timeout Error',
    'Discarded (victim of GPU error/recovery)',
    'GPU completion timed out',
    'GPU atlas allocation failed',
    'Unsupported GPU hold role',
    undefined,
  ])('keeps an unscoped older-binary error local to the current frames: %s', (reason) => {
    const { rerender } = render(<BoardImageNative {...BOARD} />);
    const current = controls.props!;
    act(() => current.onRenderError({ nativeEvent: { requestId: current.requestId, reason } }));
    expect(screen.queryByTestId('native-gpu')).toBeNull();
    expect(controls.recordFailure).not.toHaveBeenCalled();
    rerender(<BoardImageNative {...BOARD} frames="p4306r43" />);
    expect(screen.getByTestId('native-gpu')).toBeTruthy();
  });

  it.each(['reason("Invalid render config")', 'Invalid atlas offset', 'GLES3.1 required'])(
    'persists an unscoped older-binary error this binary always repeats: %s',
    (reason) => {
      render(<BoardImageNative {...BOARD} />);
      const current = controls.props!;
      act(() => current.onRenderError({ nativeEvent: { requestId: current.requestId, reason } }));
      expect(controls.recordFailure).toHaveBeenCalledExactlyOnceWith('static-config', 5);
    },
  );
});
