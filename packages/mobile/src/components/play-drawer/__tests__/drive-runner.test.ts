// @vitest-environment jsdom
// #7113: starting a drive from the wall button's swipe (or its "Light every
// climb" action): refuse, arm, commit without the busy-wall question, connect
// if needed, and light. Going live is the watcher's (drive-mode-watcher.test).
import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));

import { startDrive, type StartDriveInput } from '../drive-runner';
import { exitDriveMode, getDriveMode, getLastDriveModeExitReason, resetDriveModeForTests } from '../drive-mode-store';

function input(overrides: Partial<StartDriveInput> = {}): StartDriveInput {
  return {
    model: { swipeAction: 'drive', holder: null },
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
