// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  enabled: true,
  nativeAvailable: true,
  hidden: false,
  visibilityListeners: new Set<() => void>(),
  props: null as null | {
    requestId: string;
    frames: string;
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
vi.mock('../../providers/feature-flags-provider', () => ({ useGpuClimbOverlayEnabled: () => controls.enabled }));
vi.mock('../../hooks/use-board-accessibility-summary', () => ({ useBoardAccessibilitySummary: () => 'Board' }));
vi.mock('../board/MoonBoardGridLabels', () => ({ MoonBoardGridLabels: () => null }));
vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
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
    const gpu = props.gpuSurface && props.gpuFallbackConfigJson !== 'static-config' && props.frames !== '';
    return {
      gpuConfigJson: gpu ? 'static-config' : null,
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
