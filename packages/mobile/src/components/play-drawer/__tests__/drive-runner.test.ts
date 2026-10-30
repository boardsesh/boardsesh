// @vitest-environment jsdom
// #7113: starting a drive from the wall button's swipe (or its "Light every
// climb" action): refuse, arm, commit without the busy-wall question, connect
// if needed, light, and go live once this phone's link lights the climb.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ hapticSuccess: vi.fn(), track: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSuccess: effects.hapticSuccess }));
vi.mock('../../../lib/analytics', () => ({ track: effects.track }));

import { startDrive, useDriveGoesLive, type StartDriveInput } from '../drive-runner';
import { getDriveMode, getLastDriveModeExitReason, resetDriveModeForTests } from '../drive-mode-store';

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

  it('a late connect failure never ends a newer drive', async () => {
    let settle: (linked: boolean) => void = () => {};
    const first = input({ connected: false, connect: () => new Promise<boolean>((resolve) => (settle = resolve)) });
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    startDrive(first);
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    startDrive(input());
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

  it('ends the drive when nothing went up', () => {
    const run = input({ committing: true, commit: vi.fn(() => false) });
    expect(startDrive(run)).toBe('unavailable');
    expect(getDriveMode()).toBeNull();
    expect(run.relight).not.toHaveBeenCalled();
  });
});

describe('useDriveGoesLive', () => {
  it('goes live, with a success buzz, once the climb is lit on this phone’s link', () => {
    startDrive(input());
    const hook = renderHook((props: { lit: boolean }) => useDriveGoesLive(getDriveMode()?.phase ?? 'off', props.lit), {
      initialProps: { lit: false },
    });
    expect(getDriveMode()?.phase).toBe('arming');
    hook.rerender({ lit: true });
    expect(getDriveMode()?.phase).toBe('live');
    expect(getDriveMode()?.climbsLit).toBe(1);
    expect(effects.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('does nothing with nobody arming', () => {
    renderHook(() => useDriveGoesLive('off', true));
    expect(getDriveMode()).toBeNull();
    expect(effects.hapticSuccess).not.toHaveBeenCalled();
  });
});
