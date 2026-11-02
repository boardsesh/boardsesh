// What JS hands the Lock Screen, the Dynamic Island and the Android
// notification for the keep-lighting window (2.7), and the settings it mirrors
// for a lock-screen press to act on natively.
import { describe, expect, it } from 'vitest';
import type { DriveModeState } from '../../../components/play-drawer/drive-mode-store';
import { buildKeepLightingConfig, buildLightingWindowPayload } from '../lighting-window-payload';

function drive(overrides: Partial<DriveModeState> = {}): DriveModeState {
  return {
    phase: 'live',
    sessionId: 'session-1',
    boardId: 7,
    boardType: 'kilter',
    startedAt: 1_000,
    startedBy: 'tap',
    climbsLit: 1,
    windowMs: 45_000,
    windowSetting: 'putOnBoardKeepsLighting',
    expiresAt: 46_000,
    windowRenewals: 0,
    ...overrides,
  };
}

describe('buildLightingWindowPayload', () => {
  it('sends a window with its shown end, its length and the choice that opened it', () => {
    expect(
      buildLightingWindowPayload({
        sessionId: 'session-1',
        drive: drive({ windowSetting: 'moonboardPutOnBoardKeepsLighting' }),
        // The shown end, clamped to auto-disconnect by the store's seam.
        lighting: { mode: 'window', endsAt: 31_000 },
      }),
    ).toEqual({ sessionId: 'session-1', mode: 'window', endsAtMs: 31_000, windowSeconds: 45, family: 'moonboard' });
  });

  it('sends an open-ended drive with no end', () => {
    expect(
      buildLightingWindowPayload({
        sessionId: 'session-1',
        drive: drive({ windowMs: null, windowSetting: null, expiresAt: null }),
        lighting: { mode: 'driving', endsAt: null },
      }),
    ).toEqual({ sessionId: 'session-1', mode: 'driving', endsAtMs: null, windowSeconds: null, family: null });
  });

  it('reads arming and no drive as off: nothing lights a pick yet', () => {
    const off = { sessionId: 'session-1', mode: 'off', endsAtMs: null, windowSeconds: null, family: null };
    expect(
      buildLightingWindowPayload({
        sessionId: 'session-1',
        drive: drive({ phase: 'arming', expiresAt: null }),
        lighting: { mode: 'arming', endsAt: null },
      }),
    ).toEqual(off);
    expect(
      buildLightingWindowPayload({ sessionId: 'session-1', drive: null, lighting: { mode: 'off', endsAt: null } }),
    ).toEqual(off);
  });

  it('sends nothing outside a session: there is no card', () => {
    expect(
      buildLightingWindowPayload({ sessionId: null, drive: drive(), lighting: { mode: 'window', endsAt: 46_000 } }),
    ).toBeNull();
  });
});

describe('buildKeepLightingConfig', () => {
  const base = {
    keepLighting: '45' as const,
    moonboardKeepLighting: 'until_stopped' as const,
    drivesInSession: true,
    isCrewSession: true,
    boardName: 'kilter',
    swipeToDriveEnabled: true,
    lightOnSwipe: false,
  };

  it('mirrors both choices, In a session too, the crew and the board family', () => {
    expect(buildKeepLightingConfig(base)).toEqual({
      keepLighting: '45',
      moonboardKeepLighting: 'until_stopped',
      drivesInSession: true,
      inCrew: true,
      moonboard: false,
      enabled: true,
    });
    expect(buildKeepLightingConfig({ ...base, boardName: 'moonboard' }).moonboard).toBe(true);
  });

  it('is off where a press would not keep lighting in the app either', () => {
    // The swipe flag is keep-lighting's kill switch.
    expect(buildKeepLightingConfig({ ...base, swipeToDriveEnabled: false }).enabled).toBe(false);
    // Solo with Light the board as I swipe, every pick lights already.
    expect(buildKeepLightingConfig({ ...base, isCrewSession: false, lightOnSwipe: true }).enabled).toBe(false);
    // In a crew that setting isn't honoured, so the press keeps lighting.
    expect(buildKeepLightingConfig({ ...base, isCrewSession: true, lightOnSwipe: true }).enabled).toBe(true);
  });
});
