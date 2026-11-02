// @vitest-environment jsdom
// #7113: starting a drive from the wall button's swipe (or its "Light every
// climb" action): refuse, arm, commit without the busy-wall question, connect
// if needed, and light. Going live is the watcher's (drive-mode-watcher.test).
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));

import { startDrive, startKeepLighting, type StartDriveInput } from '../drive-runner';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
} from '../drive-mode-store';

function input(overrides: Partial<StartDriveInput> = {}): StartDriveInput {
  return {
    model: { swipeAction: 'drive', holder: null, state: 'put_on_wall' },
    wallHeldByOtherUser: false,
    sessionId: 'session-1',
    startedBy: 'swipe',
    committing: false,
    commit: vi.fn(() => true),
    connected: true,
    connect: vi.fn(() => Promise.resolve(true)),
    relight: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetDriveModeForTests();
  for (const effect of Object.values(effects)) effect.mockClear();
});
afterEach(() => resetDriveModeForTests());

describe('startDrive', () => {
  it('with the link up: arms, commits the preview without asking, and lights it', () => {
    const run = input({ committing: true, boardType: 'moonboard' });
    expect(startDrive(run)).toBe('started');
    expect(getDriveMode()).toMatchObject({ phase: 'arming', sessionId: 'session-1', boardType: 'moonboard' });
    expect(run.commit).toHaveBeenCalledOnce();
    expect(run.relight).toHaveBeenCalledOnce();
    expect(run.connect).not.toHaveBeenCalled();
  });

  it('with no link: connects, then lights it', async () => {
    const run = input({ connected: false });
    expect(startDrive(run)).toBe('started');
    expect(run.relight).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(run.connect).toHaveBeenCalledOnce();
    expect(run.relight).toHaveBeenCalledOnce();
    expect(getDriveMode()?.phase).toBe('arming');
  });

  it('ends the drive when the connect fails', async () => {
    const run = input({ connected: false, connect: vi.fn(() => Promise.resolve(false)) });
    startDrive(run);
    await act(async () => {
      await Promise.resolve();
    });
    expect(run.relight).not.toHaveBeenCalled();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('connect_failed');
  });

  it('refuses a second start while a drive is on, in the same frame too', () => {
    const first = input({ connected: false, connect: () => new Promise<boolean>(() => {}) });
    expect(startDrive(first)).toBe('started');
    const second = input({ committing: true });
    expect(startDrive(second)).toBe('unavailable');
    expect(second.commit).not.toHaveBeenCalled();
    expect(second.relight).not.toHaveBeenCalled();
  });

  it('a late connect failure never ends a newer drive', async () => {
    let settle: (linked: boolean) => void = () => {};
    const first = input({ connected: false, connect: () => new Promise<boolean>((resolve) => (settle = resolve)) });
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    startDrive(first);
    // The first drive gave up arming; a new swipe starts another.
    exitDriveMode('arming_timed_out');
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    expect(startDrive(input())).toBe('started');
    await act(async () => {
      settle(false);
      await Promise.resolve();
    });
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedAt: 2_000 });
    vi.restoreAllMocks();
  });

  it.each([
    [
      'a crewmate holds the board (the face says so)',
      { model: { swipeAction: 'drive' as const, holder: 'crew' as const, state: 'crew' as const } },
    ],
    ['presence says another account holds it', { wallHeldByOtherUser: true }],
  ])('refuses with held_by_crew when %s, and changes nothing', (_case, overrides) => {
    const run = input({ committing: true, ...overrides });
    expect(startDrive(run)).toBe('held_by_crew');
    expect(getDriveMode()).toBeNull();
    expect(run.commit).not.toHaveBeenCalled();
    expect(run.connect).not.toHaveBeenCalled();
    expect(run.relight).not.toHaveBeenCalled();
  });

  it('refuses where the control offers no swipe', () => {
    const run = input({ model: { swipeAction: null, holder: 'self', state: 'lit' } });
    expect(startDrive(run)).toBe('unavailable');
    expect(getDriveMode()).toBeNull();
    expect(run.relight).not.toHaveBeenCalled();
  });

  it('ends the drive with commit_failed when nothing went up', () => {
    const run = input({ committing: true, commit: vi.fn(() => false) });
    expect(startDrive(run)).toBe('unavailable');
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('commit_failed');
    expect(run.relight).not.toHaveBeenCalled();
  });
});

// Put on board's keep-lighting window (2.7): a swipe or Light every climb during
// it keeps every pick lighting with no end.
describe('startDrive during a keep-lighting window', () => {
  function liveWindow() {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: 'session-1',
      boardId: 7,
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      now: 1_000,
    });
    markDriveLive({ now: 2_000 });
  }

  it('turns the window open-ended, the same drive, with nothing re-sent for a lit climb', () => {
    liveWindow();
    const run = input({ model: { swipeAction: 'drive', holder: 'self', state: 'lit' } });
    expect(startDrive(run)).toBe('started');
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedAt: 1_000, startedBy: 'tap', windowMs: null });
    expect(run.commit).not.toHaveBeenCalled();
    expect(run.relight).not.toHaveBeenCalled();
    expect(run.connect).not.toHaveBeenCalled();
    // No second Drive Mode Started: it is the same drive.
    expect(effects.track.mock.calls.filter(([name]) => name === 'Drive Mode Started')).toHaveLength(1);
  });

  it('puts a climb on screen that is not lit up, as a fresh swipe would', () => {
    liveWindow();
    const run = input({ committing: true, model: { swipeAction: 'drive', holder: 'self', state: 'put_on_wall' } });
    expect(startDrive(run)).toBe('started');
    expect(run.commit).toHaveBeenCalledOnce();
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it('refuses while the window is still arming, or once open-ended already', () => {
    enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: null, windowMs: 45_000 });
    expect(startDrive(input())).toBe('unavailable');
    markDriveLive();
    expect(startDrive(input({ model: { swipeAction: 'drive', holder: 'self', state: 'lit' } }))).toBe('started');
    expect(startDrive(input({ model: { swipeAction: 'drive', holder: 'self', state: 'lit' } }))).toBe('unavailable');
  });
});

describe('startKeepLighting', () => {
  it('arms a window from the tap, the clock not started until the wall lights it', () => {
    expect(
      startKeepLighting({
        plan: { windowMs: 30_000, setting: 'putOnBoardKeepsLighting' },
        sessionId: 'session-1',
        boardType: 'kilter',
        wallHeldByOtherUser: false,
      }),
    ).toBe(true);
    expect(getDriveMode()).toMatchObject({
      phase: 'arming',
      sessionId: 'session-1',
      startedBy: 'tap',
      windowMs: 30_000,
      windowSetting: 'putOnBoardKeepsLighting',
      expiresAt: null,
    });
    expect(effects.track).toHaveBeenCalledWith('Drive Mode Started', {
      startedBy: 'tap',
      inSession: true,
      boardType: 'kilter',
    });
  });

  it('arms an open-ended drive for Until I stop', () => {
    startKeepLighting({
      plan: { windowMs: null, setting: 'putOnBoardKeepsLighting' },
      sessionId: null,
      wallHeldByOtherUser: false,
    });
    expect(getDriveMode()).toMatchObject({ phase: 'arming', windowMs: null, windowSetting: null });
  });

  it("refuses while a drive is on, or where another account's phone holds the board", () => {
    const plan = { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' } as const;
    expect(startKeepLighting({ plan, sessionId: null, wallHeldByOtherUser: true })).toBe(false);
    expect(getDriveMode()).toBeNull();
    enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    expect(startKeepLighting({ plan, sessionId: null, wallHeldByOtherUser: false })).toBe(false);
    expect(getDriveMode()?.startedBy).toBe('swipe');
  });
});
