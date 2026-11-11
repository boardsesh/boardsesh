// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../../preference-store', () => ({
  getPreference: preferences.get,
  setPreference: preferences.set,
}));

vi.mock('../spray-wall-led-sync', () => ({
  prepareSprayWallLedRead: vi.fn(async () => undefined),
  markSprayWallLedSaveStarted: vi.fn(async (_wallUuid: string, _field: string, writeCopy?: () => Promise<void>) =>
    writeCopy?.(),
  ),
  queueSprayWallLedUpload: vi.fn(),
}));

import { notifySprayLedConfiguration } from '../spray-led-config-events';
import { prepareSprayWallLedRead } from '../spray-wall-led-sync';
import { clearSprayWallRegistry, registerSprayWall } from '../spray-wall-registry';
import { useSprayWallLedsEnabled } from '../use-spray-wall-leds-enabled';

const WALL_LAYOUT = 7001;
const OTHER_WALL_LAYOUT = 7002;

const configured = { version: 1, enabled: true, controller: { type: 'wled', url: 'http://wall.local' } };
const switchedOff = { ...configured, enabled: false };

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
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleReads() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  preferences.get.mockReset().mockResolvedValue(configured);
  preferences.set.mockReset().mockResolvedValue(undefined);
  vi.mocked(prepareSprayWallLedRead).mockClear();
});

afterEach(() => {
  cleanup();
  clearSprayWallRegistry();
});

describe('useSprayWallLedsEnabled', () => {
  it('reports no lights while the settings load, then the saved answer', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const read = deferred<unknown>();
    preferences.get.mockReturnValueOnce(read.promise);
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    expect(result.current).toBe(false);
    await act(async () => read.resolve(configured));
    expect(result.current).toBe(true);
    expect(preferences.get).toHaveBeenCalledWith('sprayWallLedSettings:wall-one', { strictParsing: true });
  });

  it('reports no lights for a wall with the switch off, or never set up', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    preferences.get.mockResolvedValueOnce(switchedOff);
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallLedsEnabled('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    await settleReads();
    expect(result.current).toBe(false);

    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    preferences.get.mockResolvedValueOnce(null);
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('reports no lights with the switch on and no controller address saved', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    preferences.get.mockResolvedValueOnce({ ...configured, controller: { type: 'wled', url: '' } });
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('reports no lights on a read error or a corrupt record', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    preferences.get.mockRejectedValueOnce(new Error('storage down'));
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallLedsEnabled('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    await settleReads();
    expect(result.current).toBe(false);

    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    preferences.get.mockResolvedValueOnce({ version: 2, enabled: true });
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('reads nothing on a board that is not a spray wall', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result, rerender } = renderHook(({ boardName }) => useSprayWallLedsEnabled(boardName, WALL_LAYOUT), {
      initialProps: { boardName: 'kilter' as string | null | undefined },
    });
    await settleReads();
    expect(result.current).toBe(false);
    rerender({ boardName: null });
    rerender({ boardName: undefined });
    await settleReads();
    expect(result.current).toBe(false);
    expect(preferences.get).not.toHaveBeenCalled();
    expect(prepareSprayWallLedRead).not.toHaveBeenCalled();
  });

  it('waits for the wall to register, then reads it', async () => {
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    await settleReads();
    expect(result.current).toBe(false);
    expect(preferences.get).not.toHaveBeenCalled();

    act(() => registerWall(WALL_LAYOUT, 'wall-one'));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('ignores a late answer for the wall it just left', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    const firstWall = deferred<unknown>();
    preferences.get.mockReturnValueOnce(firstWall.promise);
    preferences.get.mockResolvedValueOnce(switchedOff);
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallLedsEnabled('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    await settleReads();
    await act(async () => firstWall.resolve(configured));
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('never carries one wall’s yes over to the next', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    registerWall(OTHER_WALL_LAYOUT, 'wall-two');
    const { result, rerender } = renderHook(({ layoutId }) => useSprayWallLedsEnabled('spray', layoutId), {
      initialProps: { layoutId: WALL_LAYOUT },
    });
    await settleReads();
    expect(result.current).toBe(true);

    preferences.get.mockReturnValueOnce(new Promise(() => undefined));
    rerender({ layoutId: OTHER_WALL_LAYOUT });
    expect(result.current).toBe(false);
  });

  it('follows a save for this wall, and ignores one for another', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    await settleReads();
    expect(result.current).toBe(true);

    act(() => notifySprayLedConfiguration('wall-two'));
    await settleReads();
    expect(preferences.get).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);

    preferences.get.mockResolvedValueOnce(switchedOff);
    act(() => notifySprayLedConfiguration('wall-one'));
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('keeps only the newest of two reads', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    await settleReads();

    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    preferences.get.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => notifySprayLedConfiguration('wall-one'));
    await settleReads();
    act(() => notifySprayLedConfiguration('wall-one'));
    await settleReads();
    await act(async () => newer.resolve(switchedOff));
    await act(async () => older.resolve(configured));
    await settleReads();
    expect(result.current).toBe(false);
  });

  it('reports no lights once the wall is withdrawn', async () => {
    registerWall(WALL_LAYOUT, 'wall-one');
    const { result } = renderHook(() => useSprayWallLedsEnabled('spray', WALL_LAYOUT));
    await settleReads();
    expect(result.current).toBe(true);

    act(() => clearSprayWallRegistry());
    expect(result.current).toBe(false);
  });
});
