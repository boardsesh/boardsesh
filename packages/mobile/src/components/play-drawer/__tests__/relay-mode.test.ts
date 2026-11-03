// @vitest-environment jsdom
// Relay mode (#7220), the relaying phone: the press action, the board
// control, the drive store's relayed drives and end reasons, what each relay
// outcome does, and the lost-path notice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

import { derivePlayDrawerLightbulbPressAction } from '../lightbulb-control';
import { resolveWallControl, type WallControlInput } from '../wall-control';
import {
  enterDriveMode,
  exitDriveMode,
  getDriveMode,
  markDriveLive,
  resetDriveModeForTests,
  shouldStartAlwaysDrive,
  startAlwaysDrive,
  type DriveModeState,
} from '../drive-mode-store';
import { startDrive, startKeepLighting } from '../drive-runner';
import { relayOutcomeEffect, driveEndSupersedesRelay } from '../relay-outcome';
import {
  claimRelayLostPath,
  formatRelayLost,
  getRelayLost,
  RELAY_LOST_NOTICE_MS,
  resetRelayLostForTests,
  showRelayLost,
} from '../relay-lost-store';

beforeEach(() => {
  resetDriveModeForTests();
  analytics.track.mockClear();
});

describe('derivePlayDrawerLightbulbPressAction — Relay mode', () => {
  const base = {
    hasBluetooth: true,
    isBluetoothConnected: false,
    isBluetoothLoading: false,
    ledless: false,
    wallHeld: false,
    holderIsAuthoritative: false,
    canRelay: false,
  };

  // flag × link mode × holder × linked collapse into `boardRelay` (relayHolderFor,
  // table-tested in lib/board-relay); this is what each combination presses.
  it.each([
    ['board relay, unlinked: relay (no doomed connect)', { boardRelay: true }, 'relay'],
    ['board relay with nothing on screen to relay: still relays the current climb', { boardRelay: true }, 'relay'],
    ['no board relay: connect as today', { boardRelay: false }, 'connect'],
    ['linked: disconnect wins', { boardRelay: true, isBluetoothConnected: true }, 'disconnect'],
    ['a connect in flight: noop', { boardRelay: true, isBluetoothLoading: true }, 'noop'],
    ['no board: noop', { boardRelay: true, hasBluetooth: false }, 'noop'],
    ['crew holder with a preview: the queue relay', { holderIsAuthoritative: true, canRelay: true }, 'relay'],
    [
      'crew holder, nothing to relay: noop, never a board relay',
      { holderIsAuthoritative: true, boardRelay: true },
      'noop',
    ],
  ] as const)('%s', (_scenario, overrides, expected) => {
    expect(derivePlayDrawerLightbulbPressAction({ ...base, ...overrides })).toBe(expected);
  });
});

describe('resolveWallControl — Relay mode', () => {
  const SAM = { name: 'Sam', avatarUrl: null };
  const RELAYING: WallControlInput = {
    commitButton: null,
    pressAction: 'relay',
    holderIsAuthoritative: true,
    boardRelay: true,
    localConnected: false,
    pending: false,
    displayedLit: false,
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: null,
    crewFace: SAM,
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    navigationCommits: false,
    swipeToDriveEnabled: true,
    keepLighting: '45',
  };

  it("reads as the holder's board, and Put on board relays", () => {
    expect(resolveWallControl(RELAYING)).toMatchObject({
      state: 'crew',
      holder: 'crew',
      holderName: 'Sam',
      tapAction: 'relay',
      labelKey: 'putOnBoard',
      swipeAction: 'drive',
      tapDrive: 'window',
      driving: false,
    });
  });

  it("a crewmate's board (no board relay) offers no swipe and no timed drive", () => {
    expect(resolveWallControl({ ...RELAYING, boardRelay: false })).toMatchObject({
      tapAction: 'relay',
      swipeAction: null,
      tapDrive: null,
    });
  });

  it('a preview swipes into a relayed drive too', () => {
    expect(resolveWallControl({ ...RELAYING, commitButton: 'putOnWall' })).toMatchObject({
      state: 'put_on_wall',
      swipeAction: 'drive',
    });
  });

  it('Always drive the wall resumes on a relay press', () => {
    expect(resolveWallControl({ ...RELAYING, alwaysDrive: true }).tapDrive).toBe('resume');
  });

  it('a live relayed drive is this climber driving: the frost, and a press stops it', () => {
    expect(resolveWallControl({ ...RELAYING, driveMode: 'live' })).toMatchObject({
      driving: true,
      labelKey: 'youAreDriving',
      tapAction: 'stop_driving',
      look: 'driving',
      swipeAction: null,
    });
    expect(resolveWallControl({ ...RELAYING, driveMode: 'live', lightWindow: true })).toMatchObject({
      tapAction: 'stop_window',
      lightWindow: true,
      swipeAction: 'drive',
    });
  });

  it('a stopped relayed drive goes back to Put on board', () => {
    expect(resolveWallControl({ ...RELAYING, driveMode: 'live', drivingStopped: true })).toMatchObject({
      driving: false,
      tapAction: 'relay',
    });
  });
});

describe('drive store — relayed drives', () => {
  it('marks a relayed drive and says so on Drive Mode Started / Ended', () => {
    enterDriveMode({ sessionId: null, boardId: 5, boardType: 'moonboard', startedBy: 'swipe', relayed: true });
    expect(getDriveMode()?.relayed).toBe(true);
    expect(analytics.track).toHaveBeenLastCalledWith('Drive Mode Started', {
      startedBy: 'swipe',
      inSession: false,
      boardType: 'moonboard',
      relayed: true,
    });
    markDriveLive();
    exitDriveMode('relay_unconfirmed');
    expect(analytics.track).toHaveBeenLastCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason: 'relay_unconfirmed', relayed: true, inSession: false }),
    );
  });

  it.each(['holder_left', 'holder_changed', 'relay_unconfirmed'] as const)('ends with %s', (reason) => {
    enterDriveMode({ sessionId: 's1', boardId: 5, startedBy: 'tap', relayed: true });
    expect(exitDriveMode(reason)?.relayed).toBe(true);
    expect(getDriveMode()).toBeNull();
    expect(analytics.track).toHaveBeenLastCalledWith(
      'Drive Mode Ended',
      expect.objectContaining({ reason, relayed: true, inSession: true }),
    );
  });

  it('leaves relayed off an ordinary drive', () => {
    enterDriveMode({ sessionId: null, boardId: 5, startedBy: 'swipe' });
    expect(getDriveMode()).not.toHaveProperty('relayed');
    expect(analytics.track.mock.calls.at(-1)?.[1]).not.toHaveProperty('relayed');
  });

  it('Always drive the wall starts on an engaged relay path, never on a bare holder', () => {
    expect(
      shouldStartAlwaysDrive({ applies: true, ownLink: false, relayEngaged: true, drive: null, stopped: false }),
    ).toBe(true);
    expect(
      shouldStartAlwaysDrive({ applies: true, ownLink: false, relayEngaged: false, drive: null, stopped: false }),
    ).toBe(false);
    expect(
      shouldStartAlwaysDrive({ applies: true, ownLink: false, relayEngaged: true, drive: null, stopped: true }),
    ).toBe(false);
    expect(startAlwaysDrive({ sessionId: null, boardId: 5, boardType: 'moonboard', relayed: true })).toBe(true);
    expect(getDriveMode()).toMatchObject({ phase: 'live', startedBy: 'always', relayed: true });
  });
});

describe('startDrive / startKeepLighting — relayed', () => {
  const model = { swipeAction: 'drive' as const, holder: 'crew' as const, state: 'crew' as const };

  it('arms a relayed drive on the holder’s board and connects nothing', () => {
    const connect = vi.fn(async () => true);
    const relight = vi.fn();
    const commit = vi.fn(() => true);
    expect(
      startDrive({
        model,
        wallHeldByOtherUser: false,
        sessionId: null,
        boardType: 'moonboard',
        startedBy: 'swipe',
        committing: true,
        commit,
        connected: false,
        connect,
        relight,
        relayed: true,
      }),
    ).toBe('started');
    expect(commit).toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(relight).not.toHaveBeenCalled();
    expect(getDriveMode()).toMatchObject({ phase: 'arming', relayed: true });
  });

  it("a crewmate's board still refuses (held_by_crew)", () => {
    expect(
      startDrive({
        model,
        wallHeldByOtherUser: false,
        sessionId: 's1',
        startedBy: 'swipe',
        committing: false,
        commit: () => true,
        connected: false,
        connect: async () => true,
        relight: () => {},
      }),
    ).toBe('held_by_crew');
    expect(getDriveMode()).toBeNull();
  });

  it('Put on board’s timed drive arms relayed', () => {
    expect(
      startKeepLighting({
        plan: { setting: 'putOnBoardKeepsLighting', windowMs: 45_000 },
        sessionId: null,
        wallHeldByOtherUser: false,
        relayed: true,
      }),
    ).toBe(true);
    expect(getDriveMode()).toMatchObject({ phase: 'arming', windowMs: 45_000, relayed: true });
  });
});

describe('relayOutcomeEffect', () => {
  const relayedArming = { phase: 'arming', relayed: true } as DriveModeState;
  const relayedLive = { phase: 'live', relayed: true } as DriveModeState;

  it('a confirmed relay engages the path and takes an arming relayed drive live', () => {
    expect(relayOutcomeEffect({ kind: 'confirmed', relayRequestId: 'r', climbUuid: 'c' }, relayedArming)).toMatchObject(
      {
        engage: true,
        goLive: true,
        endDrive: null,
        notice: null,
      },
    );
    expect(relayOutcomeEffect({ kind: 'confirmed', relayRequestId: 'r', climbUuid: 'c' }, relayedLive).goLive).toBe(
      false,
    );
  });

  it('a gone holder suppresses the path, ends the drive holder_left and says the phone let go', () => {
    expect(relayOutcomeEffect({ kind: 'holder_gone', status: 'HOLDER_UNREACHABLE' }, relayedLive)).toMatchObject({
      disengage: true,
      suppress: true,
      endDrive: 'holder_left',
      notice: 'holder_left',
    });
  });

  it('a relay that didn’t land ends the drive relay_unconfirmed and says so', () => {
    expect(relayOutcomeEffect({ kind: 'unconfirmed', cause: 'timeout' }, relayedLive)).toMatchObject({
      disengage: true,
      suppress: false,
      endDrive: 'relay_unconfirmed',
      notice: 'unconfirmed',
    });
  });

  it('outside a drive (one Put on board) it still says so, and ends nothing', () => {
    expect(
      relayOutcomeEffect({ kind: 'unconfirmed', cause: 'refused', status: 'CLIMB_UNAVAILABLE' }, null),
    ).toMatchObject({
      endDrive: null,
      notice: 'unconfirmed',
    });
  });

  it('a superseded relay (a stop, a newer pick) does nothing at all', () => {
    expect(relayOutcomeEffect({ kind: 'superseded' }, relayedLive)).toEqual({
      engage: false,
      disengage: false,
      suppress: false,
      endDrive: null,
      notice: null,
      goLive: false,
    });
  });
});

describe('relay-lost-store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRelayLostForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const t = ((key: string, options?: { name?: string }) =>
    options?.name ? `${key}:${options.name}` : key) as unknown as TFunction<'session'>;

  it('names the holder, or someone on this board', () => {
    expect(formatRelayLost({ kind: 'holder_left', name: 'Sam' }, t)).toBe('playView.wallControl.relayHolderLetGo:Sam');
    expect(formatRelayLost({ kind: 'holder_left', name: null }, t)).toBe(
      'playView.wallControl.relayHolderLetGoAnonymous',
    );
    expect(formatRelayLost({ kind: 'unconfirmed', name: 'Sam' }, t)).toBe('playView.wallControl.relayUnconfirmed:Sam');
    expect(formatRelayLost({ kind: 'unconfirmed', name: null }, t)).toBe(
      'playView.wallControl.relayUnconfirmedAnonymous',
    );
  });

  it('is said once per lost path, not per pick', () => {
    expect(claimRelayLostPath('drive:1')).toBe(true);
    expect(claimRelayLostPath('drive:1')).toBe(false);
    expect(claimRelayLostPath('press:2')).toBe(true);
  });

  it('the caption stays up for 10 s', () => {
    showRelayLost({ kind: 'unconfirmed', name: 'Sam' });
    expect(getRelayLost()).not.toBeNull();
    vi.advanceTimersByTime(RELAY_LOST_NOTICE_MS);
    expect(getRelayLost()).toBeNull();
  });
});

describe('driveEndSupersedesRelay', () => {
  it('a stop on a relayed drive (or with none left) silences the relay in flight', () => {
    expect(driveEndSupersedesRelay({ reason: 'stopped', drive: { relayed: true } as DriveModeState })).toBe(true);
    expect(driveEndSupersedesRelay({ reason: 'stopped', drive: null })).toBe(true);
  });

  it('any end of a relayed drive silences it too (the clock, a setting, a session change)', () => {
    for (const reason of ['window_ended', 'always_off', 'session_changed', 'signed_out'] as const) {
      expect(driveEndSupersedesRelay({ reason, drive: { relayed: true } as DriveModeState })).toBe(true);
    }
  });

  it('an ordinary drive ending, or a non-stop with no drive, leaves it', () => {
    expect(driveEndSupersedesRelay({ reason: 'stopped', drive: {} as DriveModeState })).toBe(false);
    expect(driveEndSupersedesRelay({ reason: 'window_ended', drive: null })).toBe(false);
  });
});
