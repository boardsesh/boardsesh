// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentStory } from '../../dev/stories/types';
import type { ClimbOverlayGPUComparison } from '../../../modules/climb-overlay-gpu/src';

const controls = vi.hoisted(() => ({
  available: true,
  compareAvailable: false,
  parameters: {} as Record<string, string>,
  compare: vi.fn<(config: string) => Promise<ClimbOverlayGPUComparison>>(),
  nativeProps: null as null | {
    requestId: string;
    onRenderReady: (event: {
      nativeEvent: {
        requestId: string;
        prepareMs: number;
        uploadMs: number;
        gpuMs: number;
        atlasBytes: number;
        atlasCacheHit: boolean;
      };
    }) => void;
    onRenderError: (event: { nativeEvent: { requestId: string; reason: string } }) => void;
  },
  renderRust: vi.fn<(config: string, key: string) => Promise<string>>(),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>,
  Switch: ({ value, onValueChange }: { value: boolean; onValueChange: (enabled: boolean) => void }) => (
    <button role="switch" aria-checked={value} onClick={() => onValueChange(!value)}>
      Enable GPU experiment
    </button>
  ),
  Share: { share: vi.fn().mockResolvedValue(undefined) },
  StyleSheet: { create: <Styles,>(styles: Styles) => styles, absoluteFill: {} },
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useLocalSearchParams: () => controls.parameters }));
vi.mock('expo-image', () => ({
  Image: ({ source, onLoad, onError }: { source: { uri: string }; onLoad?: () => void; onError?: () => void }) => (
    <img alt="board layer" src={source.uri} onLoad={onLoad} onError={onError} />
  ),
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ colorScheme: 'dark' }) }));
vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12 } }));
vi.mock('../../providers/feature-flags-provider', async () => {
  const { createContext, useContext } = await import('react');
  const FlagsContext = createContext<Record<string, boolean>>({});
  return {
    FeatureFlagsProvider: ({ flags, children }: { flags: Record<string, boolean>; children: React.ReactNode }) => (
      <FlagsContext.Provider value={flags}>{children}</FlagsContext.Provider>
    ),
    useFeatureFlag: (key: string) => useContext(FlagsContext)[key],
  };
});
vi.mock('../../dev/stories/StoryCanvas', () => ({
  StoryVariant: ({ label, children }: { label: string; children: React.ReactNode }) => (
    <section aria-label={label}>{children}</section>
  ),
}));
vi.mock('../../lib/board-details', () => ({
  getBoardRenderData: () => ({
    boardWidth: 1080,
    boardHeight: 1500,
    holdsData: Array.from({ length: 40 }, (_, index) => ({
      id: 100 + index,
      mirroredHoldId: null,
      cx: 30 + (index % 8) * 60,
      cy: 30 + Math.floor(index / 8) * 70,
      r: 12,
    })),
  }),
}));
vi.mock('@boardsesh/board-art-geometry', () => ({
  loadBoardArtGeometry: () => ({ outlines: {}, silhouetteLightness: {}, ledBright: {} }),
  getWallLightness: () => null,
}));
vi.mock('../../lib/background-image-cache', () => ({
  ensureBackgroundsCached: () => Promise.resolve({ paths: [], missingCount: 0 }),
}));
vi.mock('../../../modules/board-renderer/src', () => ({
  renderHoldsOverlay: (config: string, key: string) => controls.renderRust(config, key),
}));
vi.mock('../../../modules/climb-overlay-gpu/src', () => ({
  get compareClimbOverlayGPU() {
    return controls.compareAvailable ? controls.compare : null;
  },
  get NativeClimbOverlayGPU() {
    if (!controls.available) return null;
    return function GpuView(props: NonNullable<typeof controls.nativeProps>) {
      controls.nativeProps = props;
      return <div data-testid="gpu-view" />;
    };
  },
}));

import stories from '../GpuClimbOverlay.stories';

async function openStory() {
  await act(async () => {
    render((stories.stories.parity as ComponentStory).render());
  });
}
async function enableGpu() {
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'));
  });
}

describe('GPU parity story fallback and request ownership', () => {
  beforeEach(() => {
    controls.available = true;
    controls.compareAvailable = false;
    controls.parameters = {};
    controls.compare.mockReset();
    controls.nativeProps = null;
    controls.renderRust.mockReset().mockResolvedValue('file:///parity.png');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('starts disabled, draws Rust, and mounts GPU only after an explicit opt-in', async () => {
    await openStory();
    expect(screen.queryByTestId('gpu-view')).toBeNull();
    expect(controls.renderRust).toHaveBeenCalledOnce();
    await enableGpu();
    expect(screen.getByTestId('gpu-view')).toBeTruthy();
    await enableGpu();
    expect(screen.queryByTestId('gpu-view')).toBeNull();
  });

  it('keeps Rust visible when the optional native module is missing', async () => {
    controls.available = false;
    await openStory();
    await enableGpu();
    expect(screen.queryByTestId('gpu-view')).toBeNull();
    expect(screen.getByText('This binary has no GPU climb module. Showing Rust.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Rust PNG' })).toBeTruthy();
  });

  it('ignores an old render error and falls back only for the active request', async () => {
    await openStory();
    await enableGpu();
    const oldRequest = controls.nativeProps!;
    await act(async () => {
      fireEvent.click(screen.getByText('Next sample'));
    });
    const current = controls.nativeProps!;
    await act(async () => {
      oldRequest.onRenderError({ nativeEvent: { requestId: oldRequest.requestId, reason: 'old-failure' } });
    });
    expect(screen.queryByText(/old-failure/)).toBeNull();
    expect(screen.getByTestId('gpu-view')).toBeTruthy();
    await act(async () => {
      current.onRenderError({ nativeEvent: { requestId: current.requestId, reason: 'pipeline-failed' } });
    });
    expect(screen.queryByTestId('gpu-view')).toBeNull();
    expect(screen.getByText(/GPU unavailable: pipeline-failed/)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Rust PNG' })).toBeTruthy();
  });

  it('does not publish the previous fixture’s GPU completion as the current result', async () => {
    await openStory();
    await enableGpu();
    const oldRequest = controls.nativeProps!;
    await act(async () => {
      fireEvent.click(screen.getByText('Next sample'));
    });
    await act(async () => {
      oldRequest.onRenderReady({
        nativeEvent: {
          requestId: oldRequest.requestId,
          prepareMs: 1234,
          uploadMs: 0,
          gpuMs: 0,
          atlasBytes: 1024,
          atlasCacheHit: false,
        },
      });
    });
    expect(screen.queryByText(/1234.0 ms/)).toBeNull();
    const current = controls.nativeProps!;
    await act(async () => {
      current.onRenderReady({
        nativeEvent: {
          requestId: current.requestId,
          prepareMs: 42,
          uploadMs: 1,
          gpuMs: 2,
          atlasBytes: 1024,
          atlasCacheHit: false,
        },
      });
    });
    expect(screen.getByText(/Atlas prepare: 42.0 ms/)).toBeTruthy();
  });

  it('keeps first completion timings when the current image and GPU report ready again', async () => {
    let clock = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    await openStory();
    await enableGpu();
    const current = controls.nativeProps!;
    clock = 120;
    await act(async () => {
      fireEvent.load(screen.getByRole('img'));
    });
    clock = 130;
    await act(async () => {
      current.onRenderReady({
        nativeEvent: {
          requestId: current.requestId,
          prepareMs: 42,
          uploadMs: 1,
          gpuMs: 2,
          atlasBytes: 1024,
          atlasCacheHit: false,
        },
      });
    });
    clock = 900;
    await act(async () => {
      fireEvent.load(screen.getByRole('img'));
      current.onRenderReady({
        nativeEvent: {
          requestId: current.requestId,
          prepareMs: 999,
          uploadMs: 999,
          gpuMs: 999,
          atlasBytes: 1024,
          atlasCacheHit: true,
        },
      });
    });
    expect(screen.getByText(/image onLoad: 20.0 ms/)).toBeTruthy();
    expect(screen.getByText(/Metal callback: 30.0 ms/)).toBeTruthy();
    expect(screen.getByText(/Atlas prepare: 42.0 ms/)).toBeTruthy();
    expect(screen.queryByText(/999.0 ms/)).toBeNull();
  });

  it('gives a revisited fixture a new request and rejects the first visit’s callbacks', async () => {
    await openStory();
    await enableGpu();
    const firstVisit = controls.nativeProps!;
    await act(async () => {
      firstVisit.onRenderReady({
        nativeEvent: {
          requestId: firstVisit.requestId,
          prepareMs: 11,
          uploadMs: 1,
          gpuMs: 1,
          atlasBytes: 1024,
          atlasCacheHit: false,
        },
      });
    });
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        fireEvent.click(screen.getByText('Next sample'));
      });
    }
    const secondVisit = controls.nativeProps!;
    expect(secondVisit.requestId).not.toBe(firstVisit.requestId);
    await act(async () => {
      firstVisit.onRenderError({ nativeEvent: { requestId: firstVisit.requestId, reason: 'first-visit-failure' } });
      firstVisit.onRenderReady({
        nativeEvent: {
          requestId: firstVisit.requestId,
          prepareMs: 99,
          uploadMs: 1,
          gpuMs: 1,
          atlasBytes: 1024,
          atlasCacheHit: false,
        },
      });
    });
    expect(screen.queryByText(/first-visit-failure/)).toBeNull();
    expect(screen.queryByText(/Atlas prepare: 11.0 ms/)).toBeNull();
    expect(screen.queryByText(/Atlas prepare: 99.0 ms/)).toBeNull();
    await act(async () => {
      secondVisit.onRenderReady({
        nativeEvent: {
          requestId: secondVisit.requestId,
          prepareMs: 22,
          uploadMs: 1,
          gpuMs: 1,
          atlasBytes: 1024,
          atlasCacheHit: true,
        },
      });
    });
    expect(screen.getByText(/Atlas prepare: 22.0 ms/)).toBeTruthy();
  });

  it('defers the next automatic pixel comparison while busy and verifies each request once', async () => {
    controls.parameters = { gpu: '1', mode: 'metal', verify: '1' };
    controls.compareAvailable = true;
    const completions: Array<(comparison: ClimbOverlayGPUComparison) => void> = [];
    controls.compare.mockImplementation(() => new Promise((resolve) => completions.push(resolve)));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result: ClimbOverlayGPUComparison = {
      width: 768,
      height: 1024,
      maxChannelError: 0,
      rmse: 0,
      pixelsOverOne: 0,
      cpuRenderMs: 1,
      gpuMs: 1,
      prepareMs: 1,
      uploadMs: 1,
      atlasBytes: 1024,
      atlasCacheHit: true,
      gpuUri: 'file:///gpu.png',
      referenceUri: 'file:///reference.png',
    };
    const completeRender = async () => {
      const current = controls.nativeProps!;
      await act(async () => {
        current.onRenderReady({
          nativeEvent: {
            requestId: current.requestId,
            prepareMs: 1,
            uploadMs: 1,
            gpuMs: 1,
            atlasBytes: 1024,
            atlasCacheHit: true,
          },
        });
      });
    };
    await openStory();
    await completeRender();
    expect(controls.compare).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByText('Next sample'));
    });
    await completeRender();
    expect(controls.compare).toHaveBeenCalledTimes(1);
    await act(async () => {
      completions[0](result);
    });
    expect(controls.compare).toHaveBeenCalledTimes(2);
    await completeRender();
    await act(async () => {
      completions[1](result);
    });
    await completeRender();
    expect(controls.compare).toHaveBeenCalledTimes(2);
  });
});
