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
  HANDOFF_RETRY_RELEASE_WAIT_MS,
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

// #7113 PR 4: taking a crewmate's board. Most boxes take the newest link and
// drop the old one; some MoonBoards refuse a second phone while one is linked.
// So the runner asks Sam's phone to let go and connects at the same time, and
// retries once after the release when a strict box refused it.
describe("startDrive: taking a crewmate's board", () => {
  const SAMS_BOARD = { model: { swipeAction: 'drive' as const, holder: 'crew' as const }, connected: false };
  const flush = () =>
    act(async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });
  const handoffEvents = () =>
    effects.track.mock.calls.filter(([name]) => name === 'Board Handoff Requested').map(([, props]) => props);

  beforeEach(() => {
    // Presence has heard Sam take the board.
    noteBoardHolder({ holder: { userId: 'sam' }, connectionSeq: 4 });
  });

  it('a last-connection-wins box: asks and connects at once, never waiting on the answer', async () => {
    const handoff = handoffInput({ request: vi.fn(() => new Promise<'asked'>(() => {})) });
    const run = input({
      ...SAMS_BOARD,
      committing: true,
      handoff,
      relight: vi.fn(() => markDriveLive({ boardId: 7 })),
    });
    expect(startDrive(run)).toBe('started');
    expect(getDriveMode()).toMatchObject({ phase: 'arming', handoff: true });
    // The preview goes up first, without the busy-wall question.
    expect(run.commit).toHaveBeenCalledOnce();
    expect(handoff.request).toHaveBeenCalledOnce();
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(run.connect).not.toHaveBeenCalled();
    await flush();
    expect(run.relight).toHaveBeenCalledOnce();
    expect(getDriveMode()).toMatchObject({ phase: 'live', boardId: 7 });
    expect(handoffEvents()).toEqual([{ outcome: 'released', inSession: true }]);
    expect(isWaitingForBoardRelease()).toBe(false);
  });

  it('a strict MoonBoard released late: the scan finds it once Sam lets go, no retry needed', async () => {
    let scanFinds: (linked: boolean) => void = () => {};
    const handoff = handoffInput({ connect: vi.fn(() => new Promise<boolean>((resolve) => (scanFinds = resolve))) });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(run.relight).not.toHaveBeenCalled();
    // Sam's phone lets go; the box advertises again and the scan links.
    noteBoardHolder({ holder: null, connectionSeq: 5 });
    await act(async () => scanFinds(true));
    await flush();
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(run.relight).toHaveBeenCalledOnce();
  });

  it('a strict box found while still held: waits for the release, then one retry', async () => {
    const connect = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const handoff = handoffInput({ connect });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(connect).toHaveBeenCalledOnce();
    expect(isWaitingForBoardRelease()).toBe(true);
    // The watcher must not end the drive on that failed connect.
    expect(getDriveMode()?.phase).toBe('arming');
    noteBoardHolder({ holder: null, connectionSeq: 5 });
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(run.relight).toHaveBeenCalledOnce();
    expect(handoff.onFailed).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([{ outcome: 'released', inSession: true }]);
  });

  it('times out: no release within 5 s of a failed connect, one retry, then "Couldn\'t reach the board"', async () => {
    vi.useFakeTimers();
    const handoff = handoffInput({ connect: vi.fn(() => Promise.resolve(false)) });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(isWaitingForBoardRelease()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(HANDOFF_RETRY_RELEASE_WAIT_MS);
    });
    await flush();
    expect(handoff.connect).toHaveBeenCalledTimes(2);
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('handoff_timed_out');
    expect(handoff.onFailed).toHaveBeenCalledOnce();
    expect(run.relight).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([{ outcome: 'timed_out', inSession: true }]);
  });

  it('a refused request still connects (the box may take it), and only a failed connect says so', async () => {
    const handoff = handoffInput({ request: vi.fn(() => Promise.reject(new Error('offline'))) });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    await flush();
    expect(run.relight).toHaveBeenCalledOnce();
    expect(handoff.onFailed).not.toHaveBeenCalled();
  });

  it('a refused request and a failed connect: no retry, ends handoff_refused', async () => {
    const handoff = handoffInput({
      request: vi.fn(() => Promise.resolve('refused' as const)),
      connect: vi.fn(() => Promise.resolve(false)),
    });
    startDrive(input({ ...SAMS_BOARD, handoff }));
    await flush();
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(getLastDriveModeExitReason()).toBe('handoff_refused');
    expect(handoff.onFailed).toHaveBeenCalledOnce();
    expect(handoffEvents()).toEqual([{ outcome: 'refused', inSession: true }]);
  });

  it('nobody held it after all (free): a failed connect is not retried', async () => {
    const handoff = handoffInput({
      request: vi.fn(() => Promise.resolve('free' as const)),
      connect: vi.fn(() => Promise.resolve(false)),
    });
    startDrive(input({ ...SAMS_BOARD, handoff }));
    await flush();
    expect(handoff.connect).toHaveBeenCalledOnce();
    expect(getLastDriveModeExitReason()).toBe('handoff_timed_out');
  });

  it('stops quietly when the drive ends some other way mid-flight', async () => {
    let scanFinds: (linked: boolean) => void = () => {};
    const handoff = handoffInput({ connect: vi.fn(() => new Promise<boolean>((resolve) => (scanFinds = resolve))) });
    const run = input({ ...SAMS_BOARD, handoff });
    startDrive(run);
    exitDriveMode('session_changed');
    await act(async () => scanFinds(true));
    await flush();
    expect(run.relight).not.toHaveBeenCalled();
    expect(handoff.onFailed).not.toHaveBeenCalled();
    expect(handoffEvents()).toEqual([]);
  });
});

describe('board-handoff-store', () => {
  it('reads a null holder as free only after a holder event (not an unseeded feed)', async () => {
    noteBoardHolder({ holder: null, connectionSeq: 0 });
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
