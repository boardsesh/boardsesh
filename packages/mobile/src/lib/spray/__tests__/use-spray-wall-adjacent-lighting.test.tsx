// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TNUT_CORNERS, type TnutLayout } from '@boardsesh/spray-wall-geometry';
import type { SprayWallLedSettings } from '../spray-wall-led-cache';

const reads = vi.hoisted(() => ({
  settings: vi.fn<(wallUuid: string) => Promise<SprayWallLedSettings>>(),
  layout: vi.fn<(wallUuid: string) => Promise<TnutLayout | null>>(),
}));
vi.mock('../use-spray-wall-led-settings', () => ({ loadSprayWallLedSettings: reads.settings }));
vi.mock('../spray-wall-tnut-store', () => ({ loadSprayWallTnutLayout: reads.layout }));

import { notifySprayLedConfiguration } from '../spray-led-config-events';
import { clearSprayWallRegistry, registerSprayWall } from '../spray-wall-registry';
import { useSprayWallAdjacentLightingEligible } from '../use-spray-wall-adjacent-lighting';

const WALL_LAYOUT = 7001;
const OTHER_WALL_LAYOUT = 7002;
const configured: SprayWallLedSettings = {
  version: 1,
  brightness: 64,
  autoOffMinutes: 0,
  enabled: true,
  controller: { type: 'wled', url: 'http://wall.local' },
};

function layout(ledPlacement: TnutLayout['ledPlacement'] = 'below'): TnutLayout {
  return {
    version: 1,
    pattern: ledPlacement === 'alternating' ? 'offset' : 'grid',
    rows: 3,
    columns: 3,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    holes: [],
    photoKey: 'wall-one:1',
    ...(ledPlacement ? { ledPlacement } : {}),
  };
}

function registerWall(layoutId: number, wallUuid: string) {
  registerSprayWall(layoutId, {
    wallUuid,
    angle: 40,
    version: 1,
    versionId: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2099-01-01T00:00:00.000Z',
    holds: [],
  });
}

function deferred<T>() {
  let resolve!: (answer: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  reads.settings.mockReset().mockResolvedValue(configured);
  reads.layout.mockReset().mockResolvedValue(layout());
});

afterEach(() => {
  cleanup();
  clearSprayWallRegistry();
});

describe('useSprayWallAdjacentLightingEligible', () => {
  it('reads only after activation and stops listening for setup changes while inactive', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result, rerender } = renderHook(
      ({ enabled }) => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT, enabled),
      { initialProps: { enabled: false } },
    );
    await act(async () => notifySprayLedConfiguration('wall-one'));
    expect(result.current).toBe(false);
    expect(reads.settings).not.toHaveBeenCalled();
    expect(reads.layout).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current).toBe(true));
    expect(reads.settings).toHaveBeenCalledTimes(1);
    expect(reads.layout).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await act(async () => notifySprayLedConfiguration('wall-one'));
    expect(result.current).toBe(false);
    expect(reads.settings).toHaveBeenCalledTimes(1);
    expect(reads.layout).toHaveBeenCalledTimes(1);
  });

  it.each(['below', 'alternating'] as const)('shows the option for enabled %s LEDs', async (placement) => {
    registerWall(WALL_LAYOUT, 'wall-one');
    reads.layout.mockResolvedValue(layout(placement));
    const { result } = renderHook(() => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
    expect(reads.settings).toHaveBeenCalledWith('wall-one');
    expect(reads.layout).toHaveBeenCalledWith('wall-one');
  });

  it.each(['center', 'sides', undefined] as const)('hides the option for %s placement', async (placement) => {
    registerWall(WALL_LAYOUT, 'wall-one');
    reads.layout.mockResolvedValue({ ...layout(), ledPlacement: placement });
    const { result } = renderHook(() => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT));
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  it.each([
    { ...configured, enabled: false },
    { ...configured, controller: { type: 'wled' as const, url: '' } },
  ])('hides the option without enabled controller settings', async (settings) => {
    registerWall(WALL_LAYOUT, 'wall-one');
    reads.settings.mockResolvedValue(settings);
    const { result } = renderHook(() => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT));
    await act(async () => undefined);
    expect(result.current).toBe(false);
  });

  it('waits for both reads and fails closed on missing or unreadable layout', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const pending = deferred<TnutLayout | null>();
    reads.layout.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT));
    await act(async () => undefined);
    expect(result.current).toBe(false);
    await act(async () => pending.resolve(null));
    expect(result.current).toBe(false);
    reads.layout.mockRejectedValueOnce(new Error('read failed'));
    await act(async () => notifySprayLedConfiguration('wall-one'));
    expect(result.current).toBe(false);
  });

  it('reads nothing for other boards and follows registry arrival and withdrawal', async () => {
    const { result, rerender } = renderHook(
      ({ boardName }) => useSprayWallAdjacentLightingEligible(boardName, WALL_LAYOUT),
      {
        initialProps: { boardName: 'moonboard' },
      },
    );
    expect(reads.settings).not.toHaveBeenCalled();
    expect(reads.layout).not.toHaveBeenCalled();
    rerender({ boardName: 'spray' });
    expect(result.current).toBe(false);
    act(() => registerWall(WALL_LAYOUT, 'wall-one'));
    await waitFor(() => expect(result.current).toBe(true));
    act(() => clearSprayWallRegistry());
    expect(result.current).toBe(false);
  });

  it('hides a previous wall’s answer immediately and ignores its late read', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallAdjacentLightingEligible('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    await waitFor(() => expect(result.current).toBe(true));
    const oldWall = deferred<TnutLayout | null>();
    reads.layout.mockReturnValueOnce(oldWall.promise).mockResolvedValueOnce(layout('center'));
    act(() => notifySprayLedConfiguration('wall-one'));
    expect(result.current).toBe(false);
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    expect(result.current).toBe(false);
    await act(async () => oldWall.resolve(layout()));
    expect(result.current).toBe(false);
  });

  it('never carries an eligible wall’s answer into another wall while loading', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallAdjacentLightingEligible('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    await waitFor(() => expect(result.current).toBe(true));
    const nextWall = deferred<TnutLayout | null>();
    reads.layout.mockReturnValueOnce(nextWall.promise);
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    expect(result.current).toBe(false);
    await act(async () => nextWall.resolve(layout('center')));
    expect(result.current).toBe(false);
  });

  it('rereads only this wall and keeps only the latest configuration read', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result } = renderHook(() => useSprayWallAdjacentLightingEligible('spray', WALL_LAYOUT));
    await waitFor(() => expect(result.current).toBe(true));
    act(() => notifySprayLedConfiguration('wall-two'));
    expect(reads.layout).toHaveBeenCalledTimes(1);
    const older = deferred<TnutLayout | null>();
    const newer = deferred<TnutLayout | null>();
    reads.layout.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => notifySprayLedConfiguration('wall-one'));
    act(() => notifySprayLedConfiguration('wall-one'));
    await act(async () => newer.resolve(layout('sides')));
    await act(async () => older.resolve(layout()));
    expect(result.current).toBe(false);
    reads.layout.mockResolvedValueOnce(layout('alternating'));
    await act(async () => notifySprayLedConfiguration('wall-one'));
    expect(result.current).toBe(true);
  });
});
