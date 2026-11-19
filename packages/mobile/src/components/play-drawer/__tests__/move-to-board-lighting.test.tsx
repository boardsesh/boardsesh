// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitWallConfirm } from '@boardsesh/play-view';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: vi.fn(), hapticLight: vi.fn() }));
vi.mock('../../../lib/announce-queued', () => ({ announceQueued: vi.fn() }));
vi.mock('../../../providers/queue-provider', () => ({}));

import { moveToBoardAndLight, registerMoveLightingPolicy } from '../move-to-board-lighting';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
  startAlwaysDrive,
  isDrivingStoppedForLink,
  stopDrivingForLink,
} from '../drive-mode-store';
import { useDriveWallConfirms } from '../use-drive-follow';

function deferredConnect() {
  let resolve!: (connected: boolean) => void;
  const promise = new Promise<boolean>((settle) => {
    resolve = settle;
  });
  return { resolve, promise };
}

function request(overrides: Partial<Parameters<typeof moveToBoardAndLight>[0]> = {}) {
  return {
    boardUuid: 'gym-tension',
    boardId: 2,
    boardType: 'tension',
    climbUuid: 'tension-climb',
    sessionId: 'session-1',
    credentialScope: 1,
    plan: { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' as const },
    move: vi.fn(async () => true),
    isCurrent: vi.fn(() => true),
    relight: vi.fn(),
    ...overrides,
  };
}

let unregisterPolicy: () => void;
beforeEach(() => {
  resetDriveModeForTests();
  unregisterPolicy = registerMoveLightingPolicy(() => ({
    plan: { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' },
    resumeAlways: false,
  }));
});
afterEach(() => {
  resetDriveModeForTests();
  unregisterPolicy();
});

describe('Put on another board keeps lighting', () => {
  it('waits for the destination, then arms before reasserting and goes live only at its local confirm', async () => {
    const connecting = deferredConnect();
    const relight = vi.fn(() => {
      expect(getDriveMode()).toMatchObject({ phase: 'arming', boardType: 'tension', windowMs: 45_000 });
    });
    const run = request({ move: () => connecting.promise, relight });
    const watcher = renderHook(({ linked }) => useDriveWallConfirms(linked), { initialProps: { linked: false } });
    const completed = moveToBoardAndLight(run);
    expect(getDriveMode()).toBeNull();
    expect(run.relight).not.toHaveBeenCalled();
    act(() => emitWallConfirm('old-board-climb', 'self'));
    expect(getDriveMode()).toBeNull();
    watcher.rerender({ linked: true });
    await act(async () => {
      connecting.resolve(true);
      await completed;
    });
    expect(run.relight).toHaveBeenCalledOnce();
    act(() => emitWallConfirm('tension-climb', 'relay'));
    expect(getDriveMode()?.phase).toBe('arming');
    act(() => emitWallConfirm('tension-climb', 'self'));
    expect(getDriveMode()).toMatchObject({ phase: 'live', climbsLit: 1, windowMs: 45_000 });
    watcher.unmount();
  });

  it.each(['link_dropped', 'board_changed', 'window_ended', 'still_live'] as const)(
    'replaces the source drive after %s',
    async (sourceEnd) => {
      enterDriveMode({ sessionId: 'session-1', boardId: 1, startedBy: 'swipe', now: 1 });
      markDriveLive();
      const connecting = deferredConnect();
      const run = request({ move: () => connecting.promise });
      const completed = moveToBoardAndLight(run);
      if (sourceEnd !== 'still_live') exitDriveMode(sourceEnd);
      connecting.resolve(true);
      await completed;
      expect(getDriveMode()).toMatchObject({ phase: 'arming', boardType: 'tension', windowMs: 45_000 });
      expect(run.relight).toHaveBeenCalledOnce();
    },
  );

  it.each([false, 'reject'] as const)('never arms or relights a failed/cancelled connect: %s', async (outcome) => {
    const run = request({
      move: () => (outcome === 'reject' ? Promise.reject(new Error('failed')) : Promise.resolve(false)),
    });
    await moveToBoardAndLight(run);
    expect(getDriveMode()).toBeNull();
    expect(run.relight).not.toHaveBeenCalled();
  });

  it('drops a completion after the board, climb, session or account no longer matches', async () => {
    const run = request({ isCurrent: () => false });
    await moveToBoardAndLight(run);
    expect(getDriveMode()).toBeNull();
    expect(run.relight).not.toHaveBeenCalled();
  });

  it('coalesces duplicate taps without replacing the accepted connect', async () => {
    const connecting = deferredConnect();
    const run = request({ move: vi.fn(() => connecting.promise) });
    const first = moveToBoardAndLight(run);
    const second = moveToBoardAndLight(run);
    expect(first).toBe(second);
    expect(run.move).toHaveBeenCalledOnce();
    connecting.resolve(true);
    await first;
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it('a newer board press supersedes a delayed completion from another player', async () => {
    const connecting = deferredConnect();
    const old = request({ move: () => connecting.promise });
    const first = moveToBoardAndLight(old);
    const newer = request({ boardUuid: 'gym-kilter', boardType: 'kilter', climbUuid: 'kilter-climb' });
    await moveToBoardAndLight(newer);
    connecting.resolve(true);
    await first;
    expect(old.relight).not.toHaveBeenCalled();
    expect(newer.relight).toHaveBeenCalledOnce();
    expect(getDriveMode()?.boardType).toBe('kilter');
  });

  it.each(['live', 'stopped'] as const)('respects a newer drive that is %s', async (newerState) => {
    const connecting = deferredConnect();
    const run = request({ move: () => connecting.promise });
    const completed = moveToBoardAndLight(run);
    enterDriveMode({ sessionId: 'session-1', boardId: 2, startedBy: 'swipe', now: 123 });
    if (newerState === 'stopped') stopDrivingForLink();
    connecting.resolve(true);
    await completed;
    expect(run.relight).not.toHaveBeenCalled();
    if (newerState === 'live') expect(getDriveMode()?.startedAt).toBe(123);
    else expect(getLastDriveModeExitReason()).toBe('stopped');
  });

  it('respects a deliberate stop of the source drive during the move', async () => {
    enterDriveMode({ sessionId: 'session-1', boardId: 1, startedBy: 'swipe', now: 1 });
    markDriveLive();
    const connecting = deferredConnect();
    const run = request({ move: () => connecting.promise });
    const completed = moveToBoardAndLight(run);
    stopDrivingForLink();
    connecting.resolve(true);
    await completed;
    expect(run.relight).not.toHaveBeenCalled();
    expect(getDriveMode()).toBeNull();
  });

  it('Right away still reasserts the requested climb without starting a drive', async () => {
    const run = request({ plan: null });
    await moveToBoardAndLight(run);
    expect(run.relight).toHaveBeenCalledOnce();
    expect(getDriveMode()).toBeNull();
  });

  it('preserves a fresh destination Always drive and still releases its stale-climb hold', async () => {
    const connecting = deferredConnect();
    const run = request({ move: () => connecting.promise, plan: null, resumeAlways: true });
    const completed = moveToBoardAndLight(run);
    startAlwaysDrive({ sessionId: 'session-1', boardId: 2, boardType: 'tension' });
    const destinationDrive = getDriveMode();
    connecting.resolve(true);
    await completed;
    expect(getDriveMode()).toBe(destinationDrive);
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it('never transfers an automatic source drive that started while the move was pending', async () => {
    const connecting = deferredConnect();
    const run = request({ move: () => connecting.promise });
    const completed = moveToBoardAndLight(run);
    startAlwaysDrive({ sessionId: 'session-1', boardId: 1, boardType: 'kilter' });
    connecting.resolve(true);
    await completed;
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'tap', boardType: 'tension', windowMs: 45_000 });
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it.each([true, false])('resumes a stopped link only after a successful destination: %s', async (connected) => {
    unregisterPolicy();
    unregisterPolicy = registerMoveLightingPolicy(() => ({ plan: null, resumeAlways: true }));
    stopDrivingForLink();
    const run = request({ move: async () => connected, plan: null, resumeAlways: true });
    await moveToBoardAndLight(run);
    expect(isDrivingStoppedForLink()).toBe(!connected);
    expect(run.relight).toHaveBeenCalledTimes(connected ? 1 : 0);
  });

  it('rechecks live eligibility after the picker and still fulfills a one-climb press', async () => {
    const connecting = deferredConnect();
    const run = request({
      move: () => connecting.promise,
      plan: { windowMs: null, setting: 'putOnBoardKeepsLighting' },
    });
    const completed = moveToBoardAndLight(run);
    unregisterPolicy();
    unregisterPolicy = registerMoveLightingPolicy(() => ({ plan: null, resumeAlways: false }));
    connecting.resolve(true);
    await completed;
    expect(getDriveMode()).toBeNull();
    expect(run.relight).toHaveBeenCalledOnce();
  });
});
