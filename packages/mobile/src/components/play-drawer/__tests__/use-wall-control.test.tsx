// @vitest-environment jsdom
// The one handler behind every view of the board control (#7000): each tap
// action runs its runner, a hold opens the board sheet only with a link, and
// each event fires once with the view that was used.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  tapped: vi.fn(),
  shown: vi.fn(),
  opened: vi.fn(),
  ended: vi.fn(),
  started: vi.fn(),
  swiped: vi.fn(),
}));
const haptics = vi.hoisted(() => ({
  hapticMedium: vi.fn(),
  hapticWarning: vi.fn(),
  hapticLight: vi.fn(),
  hapticSuccess: vi.fn(),
}));
const announceQueued = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackWallControlTapped: analytics.tapped,
  trackWallControlSwiped: analytics.swiped,
  trackWallControlShown: analytics.shown,
  trackDriveModeEnded: analytics.ended,
  trackDriveModeStarted: analytics.started,
}));
vi.mock('../../../lib/analytics-board-connect', () => ({ trackBoardControlsOpened: analytics.opened }));
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../lib/announce-queued', () => ({ announceQueued }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));

import { DISCONNECT_TAP_GUARD_MS, WINDOW_END_TAP_GRACE_MS } from '../drive-tap-guards';
import { useWallControl, type DriveStartOutcome, type WallControlRunners } from '../use-wall-control';
import { usePutOnBoardIntent, usePutOnBoardIntentPress } from '../use-put-on-board-intent';
import type { KeepLightingPlan } from '../../../lib/keep-lighting';
import * as wallSwipeHint from '../../../lib/wall-swipe-hint';
import { resetAllSettings, setSetting } from '../../../settings';
import { startKeepLighting } from '../drive-runner';
import {
  EMPTY_WALL_CONTROL,
  resolveWallControl,
  type WallControlAction,
  type WallControlInput,
  type WallControlModel,
} from '../wall-control';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  makeDriveOpenEnded,
  getLastDriveModeExitReason,
  isDrivingStoppedForLink,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
  startAlwaysDrive,
  stopDrivingForLink,
} from '../drive-mode-store';

type MockRunners = {
  [Name in Exclude<keyof WallControlRunners, 'drive' | 'light' | 'lightAgain' | 'keepLighting'>]: ReturnType<
    typeof vi.fn<() => void>
  >;
} & {
  light: ReturnType<typeof vi.fn<() => boolean>>;
  lightAgain: ReturnType<typeof vi.fn<() => boolean>>;
  drive: ReturnType<typeof vi.fn<(startedBy: string) => DriveStartOutcome>>;
  keepLighting: ReturnType<typeof vi.fn<(plan: KeepLightingPlan) => void>>;
};

function runners(): MockRunners {
  return {
    light: vi.fn<() => boolean>(() => true),
    toggle: vi.fn<() => void>(),
    disconnect: vi.fn<() => void>(),
    openSheet: vi.fn<() => void>(),
    lightAgain: vi.fn<() => boolean>(() => true),
    moveToBoard: vi.fn<() => void>(),
    drive: vi.fn<(startedBy: string) => DriveStartOutcome>(() => 'started'),
    keepLighting: vi.fn<(plan: KeepLightingPlan) => void>(),
  };
}

type HookProps = { model: WallControlModel; linked?: boolean; climbUuid?: string | null; playerOpen?: boolean };

function setup(model: WallControlModel, run = runners(), visible = true) {
  const hook = renderHook(
    (props: HookProps) =>
      useWallControl({
        model: props.model,
        runners: run,
        climbUuid: props.climbUuid === undefined ? 'climb-1' : props.climbUuid,
        playerOpen: props.playerOpen ?? true,
        visible,
        linked: props.linked ?? true,
      }),
    { initialProps: { model } as HookProps },
  );
  return { hook, run };
}

const modelFor = (
  state: WallControlModel['state'],
  tapAction: WallControlAction,
  extra: Partial<WallControlModel> = {},
) =>
  ({
    ...EMPTY_WALL_CONTROL,
    state,
    tapAction,
    ...extra,
  }) as WallControlModel;

describe('useWallControl', () => {
  beforeEach(() => {
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  it.each([
    ['connect', 'connect', 'light'],
    ['put_on_wall', 'put_on_wall', 'light'],
    ['dark', 'relight', 'light'],
    ['crew', 'relay', 'toggle'],
    ['take_wall', 'take_wall', 'toggle'],
    ['release_wall', 'release_wall', 'toggle'],
    ['lit', 'disconnect', 'disconnect'],
  ] as const)('a tap on %s runs %s through %s, and logs it once', (state, action, runner) => {
    const { hook, run } = setup(modelFor(state, action));
    act(() => hook.result.current.press('button'));
    expect(run[runner]).toHaveBeenCalledOnce();
    for (const other of (['light', 'toggle', 'disconnect', 'openSheet'] as const).filter((name) => name !== runner)) {
      expect(run[other]).not.toHaveBeenCalled();
    }
    expect(analytics.tapped).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state, action, control: 'button' });
  });

  it('moves to the gym board on a tap on Put on {board}, with a medium buzz, and logs it once', () => {
    const { hook, run } = setup(modelFor('move_to_board', 'move_to_board', { gymBoardName: 'Kilter' }));
    act(() => hook.result.current.press('button'));
    expect(run.moveToBoard).toHaveBeenCalledOnce();
    for (const other of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain'] as const) {
      expect(run[other]).not.toHaveBeenCalled();
    }
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({
      state: 'move_to_board',
      action: 'move_to_board',
      control: 'button',
    });
  });

  // #7113: a press on the frosted button stops driving and keeps the link.
  it('stops driving on You are driving the wall: no disconnect, a light buzz, and says so', () => {
    resetDriveModeForTests();
    enterDriveMode({ startedBy: 'swipe', sessionId: 'session-1', boardId: 7 });
    markDriveLive();
    const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
    act(() => hook.result.current.press('button'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    for (const runner of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain', 'moveToBoard'] as const) {
      expect(run[runner]).not.toHaveBeenCalled();
    }
    expect(haptics.hapticLight).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'stop_driving', control: 'button' });
    resetDriveModeForTests();
  });

  // Owner, 2026-11-03: a bulb's tap during a drive only stops driving ("Yes,
  // every bulb"). The tablet and open-Duo bulb stands in for the player's, so
  // it runs the button's tap; the player's own first-row bulb has its own
  // block below, through the real resolver.
  const startTapDrive = (windowMs: number | null) => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: 7,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  };
  it.each([
    ["Put on board's timed drive", 'stop_window', () => startTapDrive(45_000)],
    ['an open-ended drive', 'stop_driving', () => startTapDrive(null)],
    ["Always drive the wall's drive", 'stop_driving', () => startAlwaysDrive({ sessionId: null, boardId: 7 })],
  ] as const)("stops %s from the MiniPlayer's bulb and keeps the link: no disconnect", (_drive, action, start) => {
    resetDriveModeForTests();
    start();
    expect(getDriveMode()?.phase).toBe('live');
    const { hook, run } = setup(modelFor('lit', action, { driving: true, lightWindow: action === 'stop_window' }));
    act(() => hook.result.current.press('mini_bar'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    for (const runner of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain', 'moveToBoard'] as const) {
      expect(run[runner]).not.toHaveBeenCalled();
    }
    expect(haptics.hapticLight).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'mini_bar' });
    resetDriveModeForTests();
  });

  it("drops the second tap of a double tap on the MiniPlayer's bulb: one stop, no disconnect", () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
      act(() => hook.result.current.press('mini_bar'));
      hook.rerender({ model: modelFor('lit', 'disconnect') });
      act(() => hook.result.current.press('mini_bar'));
      expect(run.disconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('mini_bar'));
      expect(run.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      resetDriveModeForTests();
    }
  });

  // A double tap on the frost must not stop driving and then let go of a crew's board.
  it('drops the second tap of a double tap on You are driving the wall', () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'stop_driving', { driving: true }));
      act(() => hook.result.current.press('button'));
      hook.rerender({ model: modelFor('lit', 'disconnect') });
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      resetDriveModeForTests();
    }
  });

  it('lets go of the board with a warning buzz, and says so once the link drops', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    act(() => hook.result.current.press('bulb'));
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(haptics.hapticMedium).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control: 'bulb' });
    // Not at the tap: the disconnect could still fail.
    expect(announceQueued).not.toHaveBeenCalled();

    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
  });

  it('says nothing when the link drops without a tap-disconnect (auto-disconnect, the sheet)', () => {
    const { hook } = setup(modelFor('lit', 'disconnect'));
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  // Fable review: the provider marks the link down before the adapter lets go,
  // so a double tap's second tap read Put on board and started a connect.
  it('turns a double tap on Disconnect board into one disconnect and no connect', () => {
    vi.useFakeTimers();
    try {
      const { hook, run } = setup(modelFor('lit', 'disconnect'));
      act(() => hook.result.current.press('button'));
      // The link already reads down: the model says Put on board.
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      act(() => hook.result.current.press('button'));
      expect(run.disconnect).toHaveBeenCalledOnce();
      expect(run.light).not.toHaveBeenCalled();
      expect(analytics.tapped).toHaveBeenCalledOnce();

      // A deliberate tap after the guard connects again.
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a noop tap but runs nothing, and ignores a tap while a connect is in flight', () => {
    const { hook, run } = setup(modelFor('lit', 'noop'));
    act(() => hook.result.current.press('mini_bar'));
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'noop', control: 'mini_bar' });
    expect(Object.values(run).some((runner) => runner.mock.calls.length > 0)).toBe(false);

    analytics.tapped.mockClear();
    hook.rerender({ model: modelFor('connect', 'connect', { pending: true }) });
    act(() => hook.result.current.press('button'));
    expect(analytics.tapped).not.toHaveBeenCalled();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('opens the board sheet on a hold while this phone holds the link, saying which view', () => {
    const { hook, run } = setup(modelFor('lit', 'disconnect', { longPress: 'sheet' }));
    act(() => hook.result.current.longPress('mini_bar'));
    expect(run.openSheet).toHaveBeenCalledOnce();
    expect(analytics.opened).toHaveBeenCalledWith({ surface: 'play_drawer', source: 'mini_bar' });
    expect(run.disconnect).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it('does nothing on a hold without a link', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    act(() => hook.result.current.longPress('button'));
    expect(run.openSheet).not.toHaveBeenCalled();
    expect(analytics.opened).not.toHaveBeenCalled();
  });

  it('keeps its handlers across renders and acts on the latest model', () => {
    const { hook, run } = setup(modelFor('connect', 'connect'));
    const first = hook.result.current;
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    expect(hook.result.current.press).toBe(first.press);
    act(() => first.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
    expect(run.light).not.toHaveBeenCalled();
  });

  it('counts Wall Control Shown for the control that asks, once', () => {
    const { hook } = setup(modelFor('connect', 'connect'));
    hook.rerender({ model: modelFor('connect', 'connect') });
    expect(analytics.shown).toHaveBeenCalledOnce();
    expect(analytics.shown).toHaveBeenCalledWith({ state: 'connect', climbUuid: 'climb-1' });
  });
});

// #7113: the wall button's swipe and its "Light every climb" action share one runner.
// Owner, 2026-11-03: "Yes, every bulb". The player's first-row bulb used to
// disconnect on a tap during a drive (`bulbTapAction`); now it runs the wall
// button's tap, so it stops driving and keeps the link, through the real
// resolver and the real drive store. With no drive it lets go, as before.
describe("useWallControl: the player's first-row bulb during a drive", () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDriveModeForTests();
    resetAllSettings();
    // The blocks after this one count their own taps from zero.
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  /** This phone's link lights the climb on screen, its own committed climb. */
  const LIT_MINE: WallControlInput = {
    commitButton: null,
    pressAction: 'disconnect',
    holderIsAuthoritative: false,
    localConnected: true,
    pending: false,
    displayedLit: true,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
  };
  const litMine = (input: Partial<WallControlInput> = {}) => resolveWallControl({ ...LIT_MINE, ...input });
  const startTapDrive = (windowMs: number | null) => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: 7,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  };
  // [drive, what the model reads, Wall Control Tapped's action, start it]
  const DRIVES = [
    [
      "Put on board's timed drive",
      { driveMode: 'live', lightWindow: true },
      'stop_window',
      () => startTapDrive(45_000),
    ],
    ['an open-ended drive', { driveMode: 'live' }, 'stop_driving', () => startTapDrive(null)],
    [
      "Always drive the wall's drive",
      { driveMode: 'live', alwaysDrive: true },
      'stop_driving',
      () => startAlwaysDrive({ sessionId: null, boardId: 7 }),
    ],
  ] as const;

  it.each(DRIVES)('stops %s on a tap and keeps the link: no disconnect', (_drive, input, action, start) => {
    start();
    expect(getDriveMode()?.phase).toBe('live');
    const model = litMine(input);
    expect(model).toMatchObject({ state: 'lit', driving: true, tapAction: action, a11yHintKey: 'stopDrivingHint' });
    const { hook, run } = setup(model);
    act(() => hook.result.current.press('bulb'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    // Always drive the wall waits for the link to drop or the next Put on board.
    expect(isDrivingStoppedForLink()).toBe(true);
    for (const runner of ['light', 'toggle', 'disconnect', 'openSheet', 'lightAgain', 'moveToBoard'] as const) {
      expect(run[runner]).not.toHaveBeenCalled();
    }
    // Drive Mode Ended once, as the frosted button's stop.
    expect(analytics.ended).toHaveBeenCalledOnce();
    expect(analytics.ended).toHaveBeenCalledWith(expect.objectContaining({ reason: 'stopped' }));
    expect(haptics.hapticLight).toHaveBeenCalledOnce();
    expect(haptics.hapticWarning).not.toHaveBeenCalled();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    expect(analytics.tapped).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action, control: 'bulb' });
  });

  it('lets go of the board with no drive, as before', () => {
    const model = litMine({ driveMode: 'off' });
    expect(model).toMatchObject({ state: 'lit', driving: false, tapAction: 'disconnect', a11yHintKey: 'litHint' });
    const { hook, run } = setup(model);
    act(() => hook.result.current.press('bulb'));
    expect(run.disconnect).toHaveBeenCalledOnce();
    expect(isDrivingStoppedForLink()).toBe(false);
    expect(haptics.hapticWarning).toHaveBeenCalledOnce();
    expect(haptics.hapticLight).not.toHaveBeenCalled();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'disconnect', control: 'bulb' });
  });

  it('lets go while a drive is still arming: nothing drives yet', () => {
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: 7, windowMs: 45_000 });
    });
    const { hook, run } = setup(litMine({ driveMode: 'arming' }));
    act(() => hook.result.current.press('bulb'));
    expect(run.disconnect).toHaveBeenCalledOnce();
  });

  it('drops the second tap of a double tap: one stop, never a hang-up', () => {
    vi.useFakeTimers();
    startTapDrive(45_000);
    const { hook, run } = setup(litMine({ driveMode: 'live', lightWindow: true }));
    act(() => hook.result.current.press('bulb'));
    // The stop landed: the bulb now reads the plain lit board, a tap that disconnects.
    hook.rerender({ model: litMine({ driveMode: 'off', drivingStopped: true }) });
    act(() => hook.result.current.press('bulb'));
    expect(run.disconnect).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DISCONNECT_TAP_GUARD_MS);
    });
    act(() => hook.result.current.press('bulb'));
    expect(run.disconnect).toHaveBeenCalledOnce();
  });

  it('says Board disconnected once the link drops after its stop, with Disconnect Bluetooth when driving ends on', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    startTapDrive(null);
    const { hook } = setup(litMine({ driveMode: 'live' }));
    act(() => hook.result.current.press('bulb'));
    expect(announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
    expect(announceQueued).not.toHaveBeenCalledWith('ble.barControl.disconnectedLabel');
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
  });

  it('says nothing more when the link drops later with the setting off', () => {
    startTapDrive(null);
    const { hook } = setup(litMine({ driveMode: 'live' }));
    act(() => hook.result.current.press('bulb'));
    announceQueued.mockClear();
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).not.toHaveBeenCalled();
  });
});

describe('useWallControl drive', () => {
  it('starts a drive where the model offers the swipe, and passes the outcome back', () => {
    const { hook, run } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive' }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(run.drive).toHaveBeenCalledExactlyOnceWith('action');
    expect(outcome).toBe('started');
    // A start is not a tap: it logs no Wall Control Tapped.
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it("passes a refusal for a crewmate's board back untouched", () => {
    const run = runners();
    run.drive.mockReturnValue('held_by_crew');
    const { hook } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive', holder: 'crew' }), run);
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(outcome).toBe('held_by_crew');
  });

  it('runs nothing where the model offers no swipe', () => {
    const { hook, run } = setup(modelFor('crew', 'relay', { swipeAction: null }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.drive('button');
    });
    expect(run.drive).not.toHaveBeenCalled();
    expect(outcome).toBe('unavailable');
  });
});

// #7113 PR 3: Wall Control Swiped, once per gesture, in the state it began in.
describe('useWallControl swipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs a drive with the state the swipe began in', () => {
    const { hook, run } = setup(modelFor('connect', 'connect', { swipeAction: 'drive' }));
    let outcome: DriveStartOutcome | null = null;
    act(() => {
      outcome = hook.result.current.swipe('button');
    });
    expect(run.drive).toHaveBeenCalledExactlyOnceWith('swipe');
    expect(outcome).toBe('started');
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({ state: 'connect', outcome: 'drive', control: 'button' });
    expect(analytics.tapped).not.toHaveBeenCalled();
  });

  it('logs a refusal when nothing starts', () => {
    const run = runners();
    run.drive.mockReturnValue('held_by_crew');
    const { hook } = setup(modelFor('put_on_wall', 'put_on_wall', { swipeAction: 'drive', holder: 'crew' }), run);
    act(() => {
      hook.result.current.swipe('button');
    });
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({
      state: 'put_on_wall',
      outcome: 'refused',
      control: 'button',
    });
  });

  it('logs a cancel and runs nothing', () => {
    const { hook, run } = setup(modelFor('dark', 'relight', { swipeAction: 'drive' }));
    act(() => {
      hook.result.current.swipeCancelled('button');
    });
    expect(run.drive).not.toHaveBeenCalled();
    expect(analytics.swiped).toHaveBeenCalledExactlyOnceWith({
      state: 'dark',
      outcome: 'cancelled',
      control: 'button',
    });
  });

  it('never logs a swipe for the screen-reader action', () => {
    const { hook } = setup(modelFor('connect', 'connect', { swipeAction: 'drive' }));
    act(() => {
      hook.result.current.drive('button');
    });
    expect(analytics.swiped).not.toHaveBeenCalled();
  });
});

describe('useWallControl: the swipe peek’s replay', () => {
  // Spec B3: the swipe peek's replay counts the presses that put a climb up.
  it('counts a Put on board on the button towards the swipe peek’s replay, never a bulb or a stop', () => {
    const presses = vi.spyOn(wallSwipeHint, 'noteWallPutOnBoardPress');
    try {
      const putUp = setup(modelFor('put_on_wall', 'put_on_wall'));
      act(() => {
        putUp.hook.result.current.press('button');
        putUp.hook.result.current.press('bulb');
      });
      const stop = setup(modelFor('lit', 'stop_driving', { driving: true }));
      act(() => {
        stop.hook.result.current.press('button');
      });
      expect(presses).toHaveBeenCalledOnce();
    } finally {
      presses.mockRestore();
    }
  });
});

describe('useWallControl: a press lights once without starting Driver mode', () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });

  /** A preview with the link up, after a press on You are driving the wall stopped it. */
  const PREVIEW_AFTER_STOP: WallControlInput = {
    commitButton: 'putOnWall',
    pressAction: 'disconnect',
    holderIsAuthoritative: false,
    localConnected: true,
    pending: false,
    displayedLit: false,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
    drivingStopped: true,
  };
  const previewAfterStop = (input: Partial<WallControlInput>) =>
    resolveWallControl({ ...PREVIEW_AFTER_STOP, ...input });

  // [case, model input, control, drive runner called, light runner called, stopped after]
  it.each<[string, Partial<WallControlInput>, 'button' | 'bulb', boolean, boolean, boolean]>([
    ['stopped, Always drive the wall on', { alwaysDrive: true }, 'button', false, true, false],
    ['stopped, Always drive the wall on, the bulb', { alwaysDrive: true }, 'bulb', false, true, false],
    ['Always drive the wall off', { alwaysDrive: false }, 'button', false, true, true],
    ['Always drive the wall off, the bulb', { alwaysDrive: false }, 'bulb', false, true, true],
    [
      'a crew, In a session too off (it does not drive here)',
      { alwaysDrive: false, crewSession: true },
      'button',
      false,
      true,
      true,
    ],
  ])('%s', (_name, input, control, drives, lights, stoppedAfter) => {
    stopDrivingForLink();
    const run = runners();
    // The runner's own effect: a drive clears the stop as it arms.
    run.drive.mockImplementation(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
      return 'started';
    });
    const { hook } = setup(previewAfterStop(input), run);
    act(() => hook.result.current.press(control));
    expect(run.drive).toHaveBeenCalledTimes(drives ? 1 : 0);
    if (drives) expect(run.drive).toHaveBeenCalledWith('tap');
    expect(run.light).toHaveBeenCalledTimes(lights ? 1 : 0);
    expect(isDrivingStoppedForLink()).toBe(stoppedAfter);
    expect(getDriveMode() !== null).toBe(drives);
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledOnce();
  });

  it('lights once and leaves a stopped link stopped with automatic lighting off', () => {
    stopDrivingForLink();
    const run = runners();
    run.drive.mockReturnValue('unavailable');
    const { hook } = setup(previewAfterStop({ alwaysDrive: false }), run);
    act(() => hook.result.current.press('button'));
    expect(run.drive).not.toHaveBeenCalled();
    expect(run.light).toHaveBeenCalledOnce();
    expect(isDrivingStoppedForLink()).toBe(true);
  });

  it('lights again without starting Driver mode on the wall with no link', () => {
    const run = runners();
    const model = resolveWallControl({
      ...PREVIEW_AFTER_STOP,
      commitButton: null,
      pressAction: 'connect',
      localConnected: false,
      displayedIsWallClimb: true,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
      alwaysDrive: false,
    });
    expect(model.state).toBe('on_wall_unlinked');
    const { hook } = setup(model, run);
    act(() => hook.result.current.press('button'));
    expect(run.drive).not.toHaveBeenCalled();
    expect(run.lightAgain).toHaveBeenCalledOnce();
  });
});

// After Put on board, keep lighting (2.7): the press runs the ordinary put-up
// and, only once its climb went up, arms the window (never through
// `startDrive`, which skips the busy-wall question).
describe('useWallControl: Put on board keeps lighting', () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDriveModeForTests();
  });

  /** A preview with the link up, solo, keep-lighting at its defaults and the flag on. */
  const PREVIEW: WallControlInput = {
    commitButton: 'putOnWall',
    pressAction: 'disconnect',
    holderIsAuthoritative: false,
    localConnected: true,
    pending: false,
    displayedLit: false,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: null,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
    alwaysDrive: false,
    swipeToDriveEnabled: true,
    keepLighting: '45',
    drivesInSession: true,
  };
  const preview = (input: Partial<WallControlInput> = {}) => resolveWallControl({ ...PREVIEW, ...input });
  /** The runner PlayCore hands it: the real store, solo. */
  const realKeepLighting = (run: MockRunners) =>
    run.keepLighting.mockImplementation((plan) => {
      startKeepLighting({ plan, sessionId: null, wallHeldByOtherUser: false });
    });

  it('puts the climb up the ordinary way, then arms the 45 s window', () => {
    const run = runners();
    realKeepLighting(run);
    const { hook } = setup(preview(), run);
    act(() => hook.result.current.press('button'));
    expect(run.light).toHaveBeenCalledOnce();
    expect(run.drive).not.toHaveBeenCalled();
    expect(run.keepLighting).toHaveBeenCalledWith({ windowMs: 45_000, setting: 'putOnBoardKeepsLighting' });
    expect(run.keepLighting.mock.invocationCallOrder[0]).toBeGreaterThan(run.light.mock.invocationCallOrder[0]);
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'tap', windowMs: 45_000, expiresAt: null });
    expect(haptics.hapticMedium).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'put_on_wall', action: 'put_on_wall', control: 'button' });
  });

  it('arms nothing while the busy-wall question holds the climb, then Put mine up arms the window', () => {
    const run = runners();
    realKeepLighting(run);
    // The question took the press: nothing went up.
    run.light.mockReturnValueOnce(false);
    const { hook } = setup(preview({ crewSession: true }), run);
    act(() => hook.result.current.press('button'));
    expect(run.keepLighting).not.toHaveBeenCalled();
    expect(getDriveMode()).toBeNull();
    // The question is up: the button waits.
    hook.rerender({ model: preview({ crewSession: true, confirmArmed: true }) });
    act(() => hook.result.current.confirmPut());
    expect(run.light).toHaveBeenCalledTimes(2);
    expect(run.keepLighting).toHaveBeenCalledOnce();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'tap', windowMs: 45_000 });
  });

  it('drops the wait on Keep theirs or on another climb; a Put mine up that does not go up arms nothing', () => {
    const run = runners();
    run.light.mockReturnValue(false);
    const { hook } = setup(preview(), run);
    act(() => hook.result.current.press('button'));
    act(() => hook.result.current.cancelPut());
    run.light.mockReturnValue(true);
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).not.toHaveBeenCalled();

    run.light.mockReturnValue(false);
    act(() => hook.result.current.press('button'));
    hook.rerender({ model: preview(), climbUuid: 'climb-2' });
    run.light.mockReturnValue(true);
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).not.toHaveBeenCalled();

    // A Put mine up that doesn't go up arms nothing either.
    run.light.mockReturnValue(false);
    act(() => hook.result.current.press('button'));
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).not.toHaveBeenCalled();
  });

  it('keeps the wait through a noop tap while the question is up, so Put mine up still keeps lighting', () => {
    const run = runners();
    realKeepLighting(run);
    run.light.mockReturnValueOnce(false);
    const { hook } = setup(preview({ crewSession: true }), run);
    act(() => hook.result.current.press('button'));
    // The question holds the second row: the first-row bulb and the MiniPlayer's do nothing.
    const asking = preview({ crewSession: true, confirmArmed: true });
    expect(asking.tapAction).toBe('noop');
    hook.rerender({ model: asking });
    act(() => hook.result.current.press('bulb'));
    act(() => hook.result.current.press('mini_bar'));
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).toHaveBeenCalledOnce();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', startedBy: 'tap', windowMs: 45_000 });
  });

  it('drops the wait on a fresh press that does something else', () => {
    const run = runners();
    run.light.mockReturnValueOnce(false);
    const { hook } = setup(preview(), run);
    act(() => hook.result.current.press('button'));
    // Keep lighting turned Off before the next press: that one lights one climb.
    hook.rerender({ model: preview({ keepLighting: 'off' }) });
    act(() => hook.result.current.press('button'));
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).not.toHaveBeenCalled();

    run.light.mockReturnValueOnce(false);
    hook.rerender({ model: preview() });
    act(() => hook.result.current.press('button'));
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
    act(() => hook.result.current.confirmPut());
    expect(run.keepLighting).not.toHaveBeenCalled();
  });

  it('only puts the climb up on a Put mine up no press of its own asked about', () => {
    const { hook, run } = setup(preview({ keepLighting: 'off' }));
    act(() => hook.result.current.confirmPut());
    expect(run.light).toHaveBeenCalledOnce();
    expect(run.keepLighting).not.toHaveBeenCalled();
  });

  it('with Until I stop, Put on board starts an open-ended drive: the frost, no window', () => {
    const run = runners();
    realKeepLighting(run);
    const { hook } = setup(preview({ keepLighting: 'until_stopped' }), run);
    act(() => hook.result.current.press('button'));
    expect(run.keepLighting).toHaveBeenCalledWith({ windowMs: null, setting: 'putOnBoardKeepsLighting' });
    act(() => markDriveLive());
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'tap', windowMs: null, expiresAt: null });
  });

  it('keeps lighting from the wall with no link too, through its light-again', () => {
    const run = runners();
    const model = preview({
      commitButton: null,
      pressAction: 'connect',
      localConnected: false,
      displayedIsWallClimb: true,
      presenceFresh: true,
      displayedIsOwnCurrent: true,
    });
    expect(model.state).toBe('on_wall_unlinked');
    const { hook } = setup(model, run);
    act(() => hook.result.current.press('button'));
    expect(run.lightAgain).toHaveBeenCalledOnce();
    expect(run.keepLighting).toHaveBeenCalledWith({ windowMs: 45_000, setting: 'putOnBoardKeepsLighting' });
  });

  it('only drops a stop where Always drive the wall drives: its own drive lights the next climbs', () => {
    stopDrivingForLink();
    const { hook, run } = setup(preview({ alwaysDrive: true, drivingStopped: true }));
    act(() => hook.result.current.press('button'));
    expect(run.light).toHaveBeenCalledOnce();
    expect(run.keepLighting).not.toHaveBeenCalled();
    expect(isDrivingStoppedForLink()).toBe(false);
  });

  it('lights one climb with keep-lighting Off, or the flag off', () => {
    for (const input of [{ keepLighting: 'off' as const }, { swipeToDriveEnabled: false }]) {
      const { hook, run } = setup(preview(input));
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
      expect(run.keepLighting).not.toHaveBeenCalled();
      hook.unmount();
    }
  });
});

describe('useWallControl: Put on board’s timed drive', () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetDriveModeForTests();
  });

  const windowModel = () =>
    modelFor('lit', 'stop_window', {
      lightWindow: true,
      driving: true,
      labelKey: 'youAreDriving',
    });
  function openWindow(windowMs = 45_000) {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => markDriveLive());
  }

  it('stops the timed drive on a press and keeps the link, with a light buzz, and says so', () => {
    const { hook, run } = setup(windowModel());
    openWindow();
    act(() => hook.result.current.press('button'));
    expect(getDriveMode()).toBeNull();
    expect(getLastDriveModeExitReason()).toBe('stopped');
    expect(isDrivingStoppedForLink()).toBe(true);
    expect(run.disconnect).not.toHaveBeenCalled();
    expect(haptics.hapticLight).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'lit', action: 'stop_window', control: 'button' });
  });

  // Disconnect Bluetooth when driving ends: the stop lets go of the board too
  // (DriveModeWatcher), so a screen reader hears it once the link drops.
  it('says Board disconnected once the link drops after a stop, with Disconnect Bluetooth when driving ends on', () => {
    setSetting('disconnectWhenDrivingEnds', true);
    try {
      const { hook } = setup(windowModel());
      openWindow();
      act(() => hook.result.current.press('button'));
      expect(announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      expect(announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
    } finally {
      resetAllSettings();
    }
  });

  it('says nothing more when the link drops later with the setting off', () => {
    const { hook } = setup(windowModel());
    openWindow();
    act(() => hook.result.current.press('button'));
    announceQueued.mockClear();
    hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('drops the second tap of a double tap on the timed drive', () => {
    vi.useFakeTimers();
    const { hook, run } = setup(windowModel());
    openWindow();
    act(() => hook.result.current.press('button'));
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).not.toHaveBeenCalled();
  });

  it('says the window once when it opens, with its length and the way to keep lighting; renewals are silent', () => {
    setup(windowModel());
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    // Arming says nothing yet: the wall hasn't lit.
    expect(announceQueued).not.toHaveBeenCalled();
    act(() => markDriveLive());
    expect(announceQueued).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.windowStarted {"count":45}');
    act(() => {
      noteDriveClimbLit();
      noteDriveClimbLit();
    });
    expect(announceQueued).toHaveBeenCalledOnce();
  });

  it('says a one-minute drive in minutes, and 2 or 5 minutes too', () => {
    setup(windowModel());
    openWindow(60_000);
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.windowStartedMinute');
    act(() => {
      exitDriveMode('stopped');
    });
    announceQueued.mockClear();
    openWindow(300_000);
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.windowStartedMinutes {"count":5}');
  });

  it('says Stopped driving the wall when the time ran out, and drops taps for 2 s after, so a stop meant for it never disconnects', () => {
    vi.useFakeTimers();
    const { hook, run } = setup(windowModel());
    openWindow();
    announceQueued.mockClear();
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(announceQueued).toHaveBeenCalledOnce();
    expect(announceQueued).toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    // The label flipped to Disconnect board under the climber's thumb.
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => hook.result.current.press('button'));
    act(() => {
      vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1);
    });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
  });

  // The route player closed and reopened from the mini player mid-window: the
  // new player never saw the window open, and still owes its end (WCAG 2.2.1).
  it('says the end of a window that was already running when the player mounted', () => {
    vi.useFakeTimers();
    openWindow();
    announceQueued.mockClear();
    const { hook, run } = setup(windowModel());
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.stoppedDriving');
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => {
      vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1);
    });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).not.toHaveBeenCalled();
  });

  it("drops a bulb's disconnect in those 2 s too", () => {
    vi.useFakeTimers();
    const { hook, run } = setup(windowModel());
    openWindow();
    act(() => {
      exitDriveMode('window_ended');
    });
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => hook.result.current.press('mini_bar'));
    act(() => hook.result.current.press('bulb'));
    expect(run.disconnect).not.toHaveBeenCalled();
  });

  it('lets Put on board through in those 2 s: only a disconnect is dropped', () => {
    vi.useFakeTimers();
    const { hook, run } = setup(windowModel());
    openWindow();
    act(() => {
      exitDriveMode('window_ended');
    });
    // The climber had already moved to a preview: the button reads Put on board.
    hook.rerender({ model: modelFor('put_on_wall', 'put_on_wall') });
    act(() => hook.result.current.press('button'));
    expect(run.light).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledWith({ state: 'put_on_wall', action: 'put_on_wall', control: 'button' });
  });

  // Disconnect Bluetooth when driving ends: the end lets go of the board, so
  // the label flips to Put on board. A tap aimed at You are driving the wall
  // must not reconnect and start a fresh drive, and a screen reader hears the
  // board go once the link drops.
  describe('with Disconnect Bluetooth when driving ends on', () => {
    beforeEach(() => setSetting('disconnectWhenDrivingEnds', true));
    afterEach(() => resetAllSettings());

    it('drops a Put on board for 2 s after the time ran out, then lets it through', () => {
      vi.useFakeTimers();
      const { hook, run } = setup(windowModel());
      openWindow();
      act(() => {
        exitDriveMode('window_ended');
      });
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      act(() => hook.result.current.press('button'));
      hook.rerender({ model: modelFor('on_wall_unlinked', 'relight'), linked: false });
      act(() => hook.result.current.press('button'));
      expect(run.light).not.toHaveBeenCalled();
      expect(run.lightAgain).not.toHaveBeenCalled();
      expect(run.keepLighting).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS);
      });
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
    });

    it('says Board disconnected once the link drops after the time ran out', () => {
      const { hook } = setup(windowModel());
      openWindow();
      act(() => {
        exitDriveMode('window_ended');
      });
      expect(announceQueued).toHaveBeenLastCalledWith('playView.wallControl.stoppedDriving');
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      expect(announceQueued).toHaveBeenLastCalledWith('ble.barControl.disconnectedLabel');
    });

    // Settings › Board ended it (Right away picked mid-drive): the link stays,
    // so a Put on board on another climb goes up and no drop is owed.
    it('drops no Put on board and owes no drop after an end Settings caused', () => {
      vi.useFakeTimers();
      const { hook, run } = setup(windowModel());
      openWindow();
      act(() => {
        exitDriveMode('window_ended', { keepLink: true });
      });
      hook.rerender({ model: modelFor('put_on_wall', 'put_on_wall') });
      act(() => hook.result.current.press('button'));
      expect(run.light).toHaveBeenCalledOnce();
      announceQueued.mockClear();
      hook.rerender({ model: modelFor('connect', 'connect'), linked: false });
      expect(announceQueued).not.toHaveBeenCalled();
    });
  });

  it('says nothing about an end it did not run out: a stop, a dropped link', () => {
    setup(windowModel());
    openWindow();
    announceQueued.mockClear();
    act(() => {
      exitDriveMode('link_dropped');
    });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('says nothing with the player closed', () => {
    const { hook } = setup(windowModel());
    hook.rerender({ model: windowModel(), playerOpen: false });
    openWindow();
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(announceQueued).not.toHaveBeenCalled();
  });

  // A window that ends before the wall lit never started for the climber: a
  // crewmate's put-up mid-connect, or the setting turned Off while arming.
  it('says nothing about a window that ended while arming, and drops no tap after it', () => {
    vi.useFakeTimers();
    const { hook, run } = setup(windowModel());
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(announceQueued).not.toHaveBeenCalledWith('playView.wallControl.stoppedDriving');
    hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => {
      vi.advanceTimersByTime(WINDOW_END_TAP_GRACE_MS - 1_000);
    });
    act(() => hook.result.current.press('button'));
    expect(run.disconnect).toHaveBeenCalledOnce();
  });

  // Nothing on the wall changes (the lit climb stays lit), so the screen
  // reader and a buzz are the only sign the window turned into a drive.
  it('says the drive is open-ended when a swipe or Light every climb opens the window up, with a buzz', () => {
    setup(windowModel());
    openWindow();
    announceQueued.mockClear();
    act(() => {
      makeDriveOpenEnded();
    });
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.sheetStatusDriving');
    expect(haptics.hapticSuccess).toHaveBeenCalledOnce();
  });

  it('says nothing about an open-ended drive that never was a window', () => {
    setup(windowModel());
    act(() => {
      enterDriveMode({ startedBy: 'swipe', sessionId: null, boardId: null });
    });
    act(() => markDriveLive());
    expect(announceQueued).not.toHaveBeenCalled();
    expect(haptics.hapticSuccess).not.toHaveBeenCalled();
  });

  // The phone split mounts a player in every tab, each with its own control.
  it('says each window line once with several players mounted, and a closed one never takes it', () => {
    vi.useFakeTimers();
    const closed = setup(windowModel());
    closed.hook.rerender({ model: windowModel(), playerOpen: false });
    const first = setup(windowModel());
    setup(windowModel());
    openWindow();
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.windowStarted {"count":45}');
    announceQueued.mockClear();
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.stoppedDriving');
    // The tap guard is each player's own: the one that stayed quiet still has it.
    first.hook.rerender({ model: modelFor('lit', 'disconnect') });
    act(() => first.hook.result.current.press('button'));
    expect(first.run.disconnect).not.toHaveBeenCalled();
    // The next window is news again.
    announceQueued.mockClear();
    vi.advanceTimersByTime(1);
    openWindow();
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.windowStarted {"count":45}');
  });

  it('says the open-ended turn once with several players mounted', () => {
    setup(windowModel());
    setup(windowModel());
    openWindow();
    announceQueued.mockClear();
    act(() => {
      makeDriveOpenEnded();
    });
    expect(announceQueued).toHaveBeenCalledExactlyOnceWith('playView.wallControl.sheetStatusDriving');
    expect(haptics.hapticSuccess).toHaveBeenCalledOnce();
  });
});

// 2.7: Wall Control Tapped says why the climb on screen is a preview.
describe('useWallControl preview reason', () => {
  beforeEach(() => analytics.tapped.mockClear());

  it.each([
    ['default', { previewReason: 'default' }],
    ['session', { previewReason: 'session' }],
    ['other_board', { previewReason: 'other_board' }],
  ] as const)('logs a tap on a %s preview with its reason', (_label, extra) => {
    const hook = renderHook(() =>
      useWallControl({
        model: modelFor('put_on_wall', 'put_on_wall'),
        runners: runners(),
        climbUuid: 'climb-1',
        playerOpen: true,
        visible: true,
        linked: true,
        previewReason: extra.previewReason,
      }),
    );
    act(() => hook.result.current.press('button'));
    expect(analytics.tapped).toHaveBeenCalledExactlyOnceWith({
      state: 'put_on_wall',
      action: 'put_on_wall',
      control: 'button',
      previewReason: extra.previewReason,
    });
  });

  it('sends no reason for the committed climb', () => {
    const hook = renderHook(() =>
      useWallControl({
        model: modelFor('dark', 'relight'),
        runners: runners(),
        climbUuid: 'climb-1',
        playerOpen: true,
        visible: true,
        linked: true,
        previewReason: null,
      }),
    );
    act(() => hook.result.current.press('button'));
    expect(analytics.tapped).toHaveBeenCalledExactlyOnceWith({ state: 'dark', action: 'relight', control: 'button' });
  });
});

// The MiniPlayer's bulb on an unlit last pick (owner decision A) asks the
// player to press Put on board for it, through this handler as the bar's
// control (`mini_bar`), which runs the button's tap, a stop included (owner,
// 2026-11-03). A request that lands on You are driving the wall must not stop
// the drive the climber never asked to end: the climb on screen is lit already.
describe("useWallControl: the bar's Put on board request", () => {
  beforeEach(() => {
    resetDriveModeForTests();
    for (const mock of [...Object.values(analytics), ...Object.values(haptics), announceQueued]) mock.mockClear();
  });
  afterEach(() => {
    resetDriveModeForTests();
  });

  function setupRequest(model: WallControlModel) {
    const run = runners();
    const clear = vi.fn();
    const hook = renderHook(
      ({ intendedFor }: { intendedFor: string | null }) => {
        const handlers = useWallControl({
          model,
          runners: run,
          climbUuid: 'climb-1',
          playerOpen: true,
          visible: true,
          linked: true,
        });
        const press = usePutOnBoardIntentPress(model.tapAction, handlers.press);
        usePutOnBoardIntent({ intendedFor, clear, previewItemUuid: 'queue-pick', ready: true, press });
      },
      { initialProps: { intendedFor: null } as { intendedFor: string | null } },
    );
    return { hook, run, clear };
  }

  it.each([
    ['an open-ended drive', null, 'stop_driving'],
    ["Put on board's timed drive", 45_000, 'stop_window'],
  ] as const)('leaves %s running: no stop, no runner, no tap counted', (_drive, windowMs, action) => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs,
        windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
      });
    });
    act(() => markDriveLive());
    const { hook, run, clear } = setupRequest(
      modelFor('lit', action, { driving: true, lightWindow: windowMs !== null, labelKey: 'youAreDriving' }),
    );
    act(() => hook.rerender({ intendedFor: 'queue-pick' }));
    // The request ran (and was dropped), but pressed nothing.
    expect(clear).toHaveBeenCalledOnce();
    expect(getDriveMode()?.phase).toBe('live');
    expect(isDrivingStoppedForLink()).toBe(false);
    for (const runner of Object.values(run)) expect(runner).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
    expect(analytics.ended).not.toHaveBeenCalled();
    expect(haptics.hapticLight).not.toHaveBeenCalled();
  });

  it('presses Put on board for the pick, counted as the bar', () => {
    const { hook, run } = setupRequest(modelFor('put_on_wall', 'put_on_wall'));
    act(() => hook.rerender({ intendedFor: 'queue-pick' }));
    expect(run.light).toHaveBeenCalledOnce();
    expect(analytics.tapped).toHaveBeenCalledExactlyOnceWith({
      state: 'put_on_wall',
      action: 'put_on_wall',
      control: 'mini_bar',
    });
  });

  it('presses nothing for a climb this wall cannot light', () => {
    const { hook, run } = setupRequest(modelFor(null, 'noop'));
    act(() => hook.rerender({ intendedFor: 'queue-pick' }));
    for (const runner of Object.values(run)) expect(runner).not.toHaveBeenCalled();
    expect(analytics.tapped).not.toHaveBeenCalled();
  });
});
