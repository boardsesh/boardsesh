// @vitest-environment jsdom
//
// Driving the wall (2.7) reaches the Lock Screen and the Android
// notification only through these sends, and native counts it down itself, so
// the contract is about WHEN JS speaks: on each change of the drive, on each
// change of the settings, after every start, never per second, never on an
// older binary, and never over a lock-screen window not yet adopted. The
// drive store is the real one.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveActivityKeepLightingConfig,
  LiveActivityLightingWindowOptions,
  LiveActivityLightingWindowSnapshot,
} from '../../../../modules/live-activity/src/index';

const harness = vi.hoisted(() => ({
  supported: true,
  /** iOS: native opens the window on a lock-screen press, from the mirrored settings. */
  mirrorsConfig: true,
  windows: [] as (LiveActivityLightingWindowOptions | null)[],
  configs: [] as (LiveActivityKeepLightingConfig | null)[],
  stored: null as LiveActivityLightingWindowSnapshot | null,
  crew: false,
  swipeToDrive: true,
  settings: {} as Record<string, unknown>,
}));

vi.mock('../../analytics', () => ({ track: vi.fn() }));
vi.mock('../../../settings', () => ({
  useSetting: (key: string) => [harness.settings[key], vi.fn()],
}));
vi.mock('../../../providers/queue-provider', () => ({ useIsCrewSession: () => harness.crew }));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useWallSwipeToDriveEnabled: () => harness.swipeToDrive,
}));
vi.mock('../live-activity-plugin', () => ({
  get sessionPresenceSupportsLightingWindow() {
    return harness.supported;
  },
  get sessionPresenceMirrorsKeepLighting() {
    return harness.mirrorsConfig;
  },
  updateLiveActivityLightingWindow: async (options: LiveActivityLightingWindowOptions | null) => {
    harness.windows.push(options);
  },
  updateLiveActivityKeepLightingConfig: async (config: LiveActivityKeepLightingConfig | null) => {
    harness.configs.push(config);
  },
  readLiveActivityLightingWindow: () => harness.stored,
}));

import {
  enterDriveMode,
  exitDriveMode,
  makeDriveOpenEnded,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
} from '../../../components/play-drawer/drive-mode-store';
import { resetLockScreenLightingForTests } from '../../../components/play-drawer/lock-screen-lighting';
import { LiveActivityLightingSync } from '../live-activity-lighting';

const T0 = Date.parse('2026-11-02T10:00:00.000Z');
const SESSION = 'session-1';
const OFF: LiveActivityLightingWindowOptions = {
  sessionId: SESSION,
  mode: 'off',
  endsAtMs: null,
  windowSeconds: null,
  family: null,
};

function renderSync({
  activityStartCount = 0,
  sessionId = SESSION,
  boardName = 'kilter',
}: { activityStartCount?: number; sessionId?: string | null; boardName?: string } = {}) {
  return render(
    <LiveActivityLightingSync sessionId={sessionId} boardName={boardName} activityStartCount={activityStartCount} />,
  );
}

function openWindow(now = T0) {
  act(() => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: SESSION,
      boardId: 7,
      windowMs: 45_000,
      windowSetting: 'putOnBoardKeepsLighting',
      now,
    });
    markDriveLive({ now });
  });
}

beforeEach(() => {
  harness.supported = true;
  harness.mirrorsConfig = true;
  harness.windows = [];
  harness.configs = [];
  harness.stored = null;
  harness.crew = false;
  harness.swipeToDrive = true;
  harness.settings = {
    putOnBoardKeepsLighting: '45',
    moonboardPutOnBoardKeepsLighting: 'until_stopped',
    putOnBoardDrivesInSession: true,
    alwaysDrive: false,
  };
  resetLockScreenLightingForTests();
});

afterEach(() => {
  cleanup();
  resetDriveModeForTests();
});

describe('LiveActivityLightingSync', () => {
  it('stays silent on a binary that predates the window', () => {
    harness.supported = false;
    harness.mirrorsConfig = false;
    renderSync();
    openWindow();
    expect(harness.windows).toEqual([]);
    expect(harness.configs).toEqual([]);
  });

  it('mirrors no settings on Android, where JS opens a notification press’s window itself', () => {
    harness.mirrorsConfig = false;
    const view = renderSync();
    harness.settings.putOnBoardKeepsLighting = '30';
    view.rerender(<LiveActivityLightingSync sessionId={SESSION} boardName="kilter" activityStartCount={1} />);
    expect(harness.configs).toEqual([]);
    // The window itself still reaches the notification.
    expect(harness.windows).toEqual([OFF, OFF]);
  });

  it('speaks on mount: the settings, and off with nothing driving', () => {
    renderSync();
    expect(harness.windows).toEqual([OFF]);
    expect(harness.configs).toEqual([
      {
        keepLighting: '45',
        moonboardKeepLighting: 'until_stopped',
        drivesInSession: true,
        inCrew: false,
        moonboard: false,
        enabled: true,
      },
    ]);
  });

  it('sends the window when it goes live, each renewal, and off at its end', () => {
    renderSync();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: SESSION,
        boardId: 7,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
        now: T0,
      });
    });
    // Arming lights nothing yet: still off, so nothing new is sent.
    expect(harness.windows).toEqual([OFF]);
    act(() => markDriveLive({ now: T0 }));
    expect(harness.windows.at(-1)).toEqual({
      sessionId: SESSION,
      mode: 'window',
      endsAtMs: T0 + 45_000,
      windowSeconds: 45,
      family: 'general',
    });
    act(() => noteDriveClimbLit({ now: T0 + 10_000 }));
    act(() => noteDriveClimbLit({ now: T0 + 20_000 }));
    expect(harness.windows.at(-1)?.endsAtMs).toBe(T0 + 65_000);
    act(() => {
      exitDriveMode('window_ended');
    });
    expect(harness.windows.at(-1)).toEqual(OFF);
    expect(harness.windows).toHaveLength(5);
  });

  it('sends a drive with no end, and nothing for a lit climb that changes nothing', () => {
    renderSync();
    openWindow();
    act(() => {
      makeDriveOpenEnded();
    });
    expect(harness.windows.at(-1)).toMatchObject({ mode: 'driving', endsAtMs: null });
    const sent = harness.windows.length;
    act(() => noteDriveClimbLit({ now: T0 + 5_000 }));
    expect(harness.windows).toHaveLength(sent);
  });

  it('re-sends both after every Live Activity start', () => {
    const view = renderSync();
    openWindow();
    const windowSends = harness.windows.length;
    view.rerender(<LiveActivityLightingSync sessionId={SESSION} boardName="kilter" activityStartCount={1} />);
    expect(harness.windows).toHaveLength(windowSends + 1);
    expect(harness.windows.at(-1)?.mode).toBe('window');
    expect(harness.configs).toHaveLength(2);
  });

  it('mirrors a settings change, the crew forming and a MoonBoard', () => {
    const view = renderSync();
    harness.settings.putOnBoardKeepsLighting = 'off';
    harness.crew = true;
    view.rerender(<LiveActivityLightingSync sessionId={SESSION} boardName="moonboard" activityStartCount={0} />);
    expect(harness.configs.at(-1)).toMatchObject({ keepLighting: 'off', inCrew: true, moonboard: true });
    // An unchanged render sends nothing more.
    const sends = harness.configs.length;
    view.rerender(<LiveActivityLightingSync sessionId={SESSION} boardName="moonboard" activityStartCount={0} />);
    expect(harness.configs).toHaveLength(sends);
  });

  // Light automatically drives every pick already: a lock-screen press lights
  // its climb and starts no drive, so native is told to keep none.
  it('mirrors Light automatically turning on as a press that keeps nothing lighting', () => {
    const view = renderSync();
    expect(harness.configs.at(-1)).toMatchObject({ enabled: true });
    harness.settings.alwaysDrive = true;
    view.rerender(<LiveActivityLightingSync sessionId={SESSION} boardName="kilter" activityStartCount={0} />);
    expect(harness.configs.at(-1)).toMatchObject({ enabled: false });
  });

  it('clears both outside a session', () => {
    renderSync({ sessionId: null });
    expect(harness.windows).toEqual([null]);
    expect(harness.configs).toEqual([null]);
  });

  it('never covers a lock-screen window the drive store has not adopted with off', () => {
    harness.stored = {
      sessionId: SESSION,
      mode: 'window',
      endsAtMs: Date.now() + 30_000,
      windowSeconds: 45,
      family: 'general',
      source: 'lockScreen',
      updatedAtMs: Date.now() - 1_000,
    };
    renderSync();
    expect(harness.windows).toEqual([]);
    // Once it has run out, the next change of the drive speaks again.
    harness.stored = { ...harness.stored, endsAtMs: Date.now() - 1 };
    openWindow(Date.now());
    expect(harness.windows.at(-1)?.mode).toBe('window');
    act(() => {
      exitDriveMode('stopped');
    });
    expect(harness.windows.at(-1)).toEqual(OFF);
  });
});
