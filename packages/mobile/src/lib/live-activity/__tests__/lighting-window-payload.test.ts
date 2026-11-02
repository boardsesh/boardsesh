// What JS hands the Lock Screen, the Dynamic Island and the Android
// notification for driving the wall (2.7), and the settings it mirrors
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
  it('sends a timed drive with its own end, its length and the choice that started it', () => {
    expect(
      buildLightingWindowPayload({
        sessionId: 'session-1',
        drive: drive({ windowSetting: 'moonboardPutOnBoardKeepsLighting' }),
        // The drive's own end: nothing clamps it since auto-disconnect went (2.7).
        lighting: { mode: 'window', endsAt: 46_000 },
      }),
    ).toEqual({ sessionId: 'session-1', mode: 'window', endsAtMs: 46_000, windowSeconds: 45, family: 'moonboard' });
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
      lockScreenStop: true,
    });
    expect(buildKeepLightingConfig({ ...base, boardName: 'moonboard' }).moonboard).toBe(true);
  });

  it('mirrors Right away and the 2 and 5 minute choices as stored: native reads off as one climb, no drive', () => {
    expect(buildKeepLightingConfig({ ...base, keepLighting: 'off', moonboardKeepLighting: '300' })).toMatchObject({
      keepLighting: 'off',
      moonboardKeepLighting: '300',
      enabled: true,
    });
    expect(buildKeepLightingConfig({ ...base, keepLighting: '120' }).keepLighting).toBe('120');
  });

  it('tells the Lock Screen bulb this JS takes a stop, whatever the settings', () => {
    // Without it the bulb keeps re-lighting during a drive: an older JS would
    // put the drive straight back on the card.
    expect(buildKeepLightingConfig(base).lockScreenStop).toBe(true);
    expect(buildKeepLightingConfig({ ...base, swipeToDriveEnabled: false }).lockScreenStop).toBe(true);
  });

  it('is off where a press would not start a drive in the app either', () => {
    // The swipe flag is the drive's kill switch.
    expect(buildKeepLightingConfig({ ...base, swipeToDriveEnabled: false }).enabled).toBe(false);
    // Solo with Light the board as I swipe, every pick lights already.
    expect(buildKeepLightingConfig({ ...base, isCrewSession: false, lightOnSwipe: true }).enabled).toBe(false);
    // In a crew that setting isn't honoured, so the press keeps lighting.
    expect(buildKeepLightingConfig({ ...base, isCrewSession: true, lightOnSwipe: true }).enabled).toBe(true);
  });
});
