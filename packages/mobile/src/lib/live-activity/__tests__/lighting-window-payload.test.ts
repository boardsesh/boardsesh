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
        // A MoonBoard's timed drive too: Stop driving after is one choice for every board.
        drive: drive({ boardType: 'moonboard' }),
        // The drive's own end: nothing clamps it since auto-disconnect went (2.7).
        lighting: { mode: 'window', endsAt: 46_000 },
      }),
    ).toEqual({ sessionId: 'session-1', mode: 'window', endsAtMs: 46_000, windowSeconds: 45, family: 'general' });
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
    drivesInSession: true,
    isCrewSession: true,
    swipeToDriveEnabled: true,
    alwaysDrive: false,
  };

  it('mirrors the choice, In a session too and the crew', () => {
    expect(buildKeepLightingConfig(base)).toEqual({
      keepLighting: '45',
      moonboardKeepLighting: '45',
      drivesInSession: true,
      inCrew: true,
      moonboard: false,
      enabled: true,
      lockScreenStop: true,
    });
  });

  // An older binary's `SharedKeepLighting.plan(for:)` takes
  // `moonboardKeepLighting` in a crew too when `moonboard` is true; a later one
  // reads neither. JS never says MoonBoard and sends the general choice in that
  // slot, so a press on a MoonBoard's card follows the general rule, In a
  // session too included, on either binary.
  it.each(['off', '30', '45', '60', '120', '300', 'until_stopped'] as const)(
    'never tells the binary the board is a MoonBoard, and sends %s in its slot too',
    (keepLighting) => {
      const config = buildKeepLightingConfig({ ...base, keepLighting, isCrewSession: true, drivesInSession: false });
      expect(config.moonboard).toBe(false);
      expect(config.moonboardKeepLighting).toBe(keepLighting);
    },
  );

  it('mirrors Right away and the 2 and 5 minute choices as stored: native reads off as one climb, no drive', () => {
    expect(buildKeepLightingConfig({ ...base, keepLighting: 'off' })).toMatchObject({
      keepLighting: 'off',
      moonboardKeepLighting: 'off',
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
    // Where Always drive the wall drives, every pick lights already: solo, and
    // in a crew with In a session too on.
    expect(buildKeepLightingConfig({ ...base, isCrewSession: false, alwaysDrive: true }).enabled).toBe(false);
    expect(buildKeepLightingConfig({ ...base, isCrewSession: true, alwaysDrive: true }).enabled).toBe(false);
    // In a crew with In a session too off it doesn't drive, on any board, so
    // the press keeps lighting (and native's own crew rule decides it).
    expect(
      buildKeepLightingConfig({ ...base, isCrewSession: true, drivesInSession: false, alwaysDrive: true }).enabled,
    ).toBe(true);
  });
});
