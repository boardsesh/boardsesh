// @vitest-environment jsdom
//
// The tap prewarm renders the tapped climb's play-size PNG before the drawer
// mounts. On a board the player draws on the live GPU, once that drawing is warm
// in this process (the hook decides), the PNG is never shown, so the host only
// decodes what is already cached.
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BOARD_RENDER_SETTINGS } from '../../../lib/board-render-settings';

const controls = vi.hoisted(() => ({
  gpuEnabled: true,
  motionNative: true,
  hookInputs: [] as Array<{
    frames: string;
    cachedOnlyOnceGpuWarm?: boolean;
    gpuCatalogueNative?: boolean;
    renderWidth?: number;
  }>,
}));

vi.mock('../../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: (params: {
    frames: string;
    cachedOnlyOnceGpuWarm?: boolean;
    gpuCatalogueNative?: boolean;
    renderWidth?: number;
  }) => {
    controls.hookInputs.push(params);
    return { overlayUri: null, overlayLoadKey: null, backgroundPaths: [] };
  },
}));
vi.mock('../../../hooks/use-play-drawer-surface', () => ({ usePlayDrawerSurface: () => ({ fieldColor: '#1C1C1E' }) }));
vi.mock('../../../lib/board-render/warm-board-art-memory', () => ({ warmBoardArtMemory: vi.fn() }));
vi.mock('../../LayeredClimbImage', () => ({ backgroundImageUri: (path: string) => path }));
vi.mock('../../../lib/board-render/gpu-native-capability', () => ({ climbOverlayGpuApiVersion: 6 }));
vi.mock('../../../../modules/climb-overlay-gpu/src', () => ({
  get NativeMotionClimbOverlayGPU() {
    return controls.motionNative ? () => null : null;
  },
}));
vi.mock('../../../lib/board-render-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/board-render-settings')>()),
  useBoardRenderSettings: () => ({ settings: { ...DEFAULT_BOARD_RENDER_SETTINGS, mode: 'aura' } }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useGpuClimbOverlayEnabled: () => controls.gpuEnabled,
}));

import { PlayBoardPrewarmHost } from '../PlayBoardPrewarmHost';
import {
  _resetPlayBoardPrewarmForTests,
  rememberPlayOverlayWidth,
  requestPlayBoardPrewarm,
} from '../../../lib/board-render/play-board-prewarm';

const HOMEWALL = { boardName: 'kilter' as const, layoutId: 8, sizeId: 25, setIds: '26,27,28,29' };

describe('PlayBoardPrewarmHost', () => {
  beforeEach(() => {
    _resetPlayBoardPrewarmForTests();
    controls.gpuEnabled = true;
    controls.motionNative = true;
    controls.hookInputs = [];
    rememberPlayOverlayWidth(HOMEWALL, 750);
  });
  afterEach(cleanup);

  it('skips the render once warm for a board the player draws on the GPU, naming its drawing', () => {
    render(<PlayBoardPrewarmHost />);
    act(() => requestPlayBoardPrewarm(HOMEWALL, 'p4131r42'));
    expect(controls.hookInputs.at(-1)).toMatchObject({
      frames: 'p4131r42',
      renderWidth: 750,
      cachedOnlyOnceGpuWarm: true,
      gpuCatalogueNative: true,
    });
  });

  it.each(['flag', 'binary'] as const)('renders the PNG ahead when the %s keeps the player on PNG', (reason) => {
    controls.gpuEnabled = reason !== 'flag';
    controls.motionNative = reason !== 'binary';
    render(<PlayBoardPrewarmHost />);
    act(() => requestPlayBoardPrewarm(HOMEWALL, 'p4131r42'));
    expect(controls.hookInputs.at(-1)).toMatchObject({ frames: 'p4131r42', cachedOnlyOnceGpuWarm: false });
  });
});
