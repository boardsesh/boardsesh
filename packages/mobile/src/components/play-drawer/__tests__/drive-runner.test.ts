// @vitest-environment jsdom
// #7113: starting a drive from the wall button's swipe (or its "Light every
// climb" action): refuse, arm, commit without the busy-wall question, connect
// if needed, and light. Going live is the watcher's (drive-mode-watcher.test).
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));

import { startDrive, type HandoffInput, type StartDriveInput } from '../drive-runner';
import {
  exitDriveMode,
  getDriveMode,
  getLastDriveModeExitReason,
  markDriveLive,
  resetDriveModeForTests,
} from '../drive-mode-store';
import {
  HANDOFF_RELEASE_TIMEOUT_MS,
  isWaitingForBoardRelease,
  noteBoardHolder,
  resetBoardHandoffStoreForTests,
  waitForBoardRelease,
} from '../board-handoff-store';

function handoffInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    holderUserId: 'sam',
    request: vi.fn(() => Promise.resolve('asked' as const)),
    waitForRelease: (holderUserId: string) => waitForBoardRelease({ holderUserId }),
    connect: vi.fn(() => Promise.resolve(true)),
    onFailed: vi.fn(),
    ...overrides,
  };
}

function input(overrides: Partial<StartDriveInput> = {}): StartDriveInput {
  return {
    model: { swipeAction: 'drive', holder: null },
    wallHeldByOtherUser: false,
    sessionId: 'session-1',
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
  resetBoardHandoffStoreForTests();
  for (const effect of Object.values(effects)) effect.mockClear();
});
afterEach(() => {
  resetDriveModeForTests();
  resetBoardHandoffStoreForTests();
  vi.useRealTimers();
});

describe('startDrive', () => {
  it('with the link up: arms, commits the preview without asking, and lights it', () => {
    const run = input({ committing: true });
    expect(startDrive(run)).toBe('started');
    expect(getDriveMode()).toMatchObject({ phase: 'arming', sessionId: 'session-1' });
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
      { model: { swipeAction: 'drive' as const, holder: 'crew' as const } },
    ],
    ['presence says another account holds it', { wallHeldByOtherUser: true }],
    [
      // A virtual hold on a wall with no lights has no radio to hand over.
      'another account holds a wall with no lights, even with a hand-off on offer',
      { wallHeldByOtherUser: true, handoff: handoffInput() },
    ],
  ])('refuses with needs_handoff when %s, and changes nothing', (_case, overrides) => {
    const run = input({ committing: true, ...overrides });
    expect(startDrive(run)).toBe('needs_handoff');
    expect(getDriveMode()).toBeNull();
    expect(run.commit).not.toHaveBeenCalled();
    expect(run.connect).not.toHaveBeenCalled();
    expect(run.relight).not.toHaveBeenCalled();
  });

  it('refuses where the control offers no swipe', () => {
    const run = input({ model: { swipeAction: null, holder: 'self' } });
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

// #7113 PR 4: taking a crewmate's board. Their phone has to let go first
// (Aurora and MoonBoard boxes stop advertising once linked), so the runner asks,
// waits for presence to show the board free, and only then connects.
describe("startDrive: taking a crewmate's board", () => {
  const SAMS_BOARD = { model: { swipeAction: 'drive' as const, holder: 'crew' as const }, connected: false };
  const flush = () =>
    act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    });
  const handoffEvents = () =>
    effects.track.mock.calls.filter(([name]) => name === 'Board Handoff Requested').map(([, props]) => props);

  beforeEach(() => {
    // Presence has heard Sam take the board.
    noteBoardHolder({ holder: { userId: 'sam' }, connectionSeq: 4 });
  });

  it('needs_handoff → requested → released → connect → live', async () => {
    const handoff = handoffInput();
    const run = input({
      ...SAMS_BOARD,
      committing: true,
      handoff,
      relight: vi.fn(() => markDriveLive({ boardId: 7 })),
    });
    expect(startDrive(run)).toBe('started');
    expect(getDriveMode()?.phase).toBe('arming');
    // The preview goes up first, without the busy-wall question.
    expect(run.commit).toHaveBeenCalledOnce();
    await flush();
    expect(handoff.request).toHaveBeenCalledOnce();
    // Never a connect while Sam's phone still holds the radio.
    expect(isWaitingForBoardRelease()).toBe(true);
    expect(handoff.connect).not.toHaveBeenCalled();
    expect(run.connect).not.toHaveBeenCalled();

    // Sam's phone let go: presence shows the board free.
    noteBoardHolder({ holder: null, connectionSeq: 5 });
    await flush();
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(run.connect).not.toHaveBeenCalled();
    expect(run.relight).toHaveBeenCalledOnce();
    expect(getDriveMode()).toMatchObject({ phase: 'live', boardId: 7 });
    expect(handoffEvents()).toEqual([{ outcome: 'released', inSession: true }]);
    expect(handoff.onFailed).not.toHaveBeenCalled();
  });

  it('times out after 12 s with no release: ends the drive and says so, never connecting', async () => {
    vi.useFakeTimers();
    const handoff = handoffInput();
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(isWaitingForBoardRelease()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(HANDOFF_RELEASE_TIMEOUT_MS - 1);
    });
    expect(getDriveMode()?.phase).toBe('arming');
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('handoff_timed_out');
    expect(handoff.onFailed).toHaveBeenCalledOnce();
    expect(handoff.connect).not.toHaveBeenCalled();
    expect(run.relight).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([{ outcome: 'timed_out', inSession: true }]);
  });

  it('a refused request (or one that never reached the server) ends the drive at once', async () => {
    const handoff = handoffInput({ request: vi.fn(() => Promise.reject(new Error('offline'))) });
    startDrive(input({ ...SAMS_BOARD, handoff }));
    await flush();
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('handoff_refused');
    expect(handoff.onFailed).toHaveBeenCalledOnce();
    expect(handoff.connect).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([{ outcome: 'refused', inSession: true }]);
  });

  it('connects straight away when the server says nobody holds it any more', async () => {
    const handoff = handoffInput({ request: vi.fn(() => Promise.resolve('free' as const)) });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(isWaitingForBoardRelease()).toBe(false);
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it('counts a release that landed while the request was in flight', async () => {
    let answer: (asked: 'asked') => void = () => {};
    const handoff = handoffInput({ request: () => new Promise((resolve) => (answer = resolve)) });
    startDrive(input({ ...SAMS_BOARD, handoff }));
    noteBoardHolder({ holder: null, connectionSeq: 5 });
    await act(async () => {
      answer('asked');
    });
    await flush();
    expect(handoff.connect).toHaveBeenCalledOnce();
  });

  it('a failed connect after the release ends the drive as connect_failed', async () => {
    const handoff = handoffInput({
      request: vi.fn(() => Promise.resolve('free' as const)),
      connect: vi.fn(() => Promise.resolve(false)),
    });
    startDrive(input({ ...SAMS_BOARD, handoff }));
    await flush();
    expect(getLastDriveModeExitReason()).toBe('connect_failed');
    expect(handoff.onFailed).not.toHaveBeenCalled();
  });

  it('stops quietly when the drive ends some other way mid-wait', async () => {
    const handoff = handoffInput();
    startDrive(input({ ...SAMS_BOARD, handoff }));
    await flush();
    exitDriveMode('session_changed');
    noteBoardHolder({ holder: null, connectionSeq: 5 });
    await flush();
    expect(handoff.connect).not.toHaveBeenCalled();
    expect(handoff.onFailed).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([]);
  });
});

describe('board-handoff-store', () => {
  it('reads a null holder as free only after a holder event (not an unseeded feed)', async () => {
    noteBoardHolder({ holder: null, connectionSeq: 0 });
    vi.useFakeTimers();
    const waiting = waitForBoardRelease({ holderUserId: 'sam', timeoutMs: 100 });
    expect(isWaitingForBoardRelease()).toBe(true);
    noteBoardHolder({ holder: null, connectionSeq: 3 });
    await expect(waiting).resolves.toBe('released');
  });

  it('counts anyone else holding it as released', async () => {
    noteBoardHolder({ holder: { userId: 'sam' }, connectionSeq: 3 });
    const waiting = waitForBoardRelease({ holderUserId: 'sam' });
    noteBoardHolder({ holder: { userId: 'kim' }, connectionSeq: 4 });
    await expect(waiting).resolves.toBe('released');
  });
});
