// Stop driving after (2.7): the choices, how a stored value reads back, and
// which choice a press takes on which board.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_LIGHTING,
  DEFAULT_MOONBOARD_KEEP_LIGHTING,
  KEEP_LIGHTING_CHOICES,
  alwaysDriveApplies,
  driveLengthWords,
  keepLightingWindowMs,
  lockScreenPressKeepsLighting,
  resolveKeepLightingPlan,
  resolveKeepLightingReach,
  sanitiseKeepLighting,
} from '../keep-lighting';
import { DEFAULT_SETTINGS } from '../../settings/defaults';

describe('keep-lighting choices', () => {
  it('defaults to a 45 s window, Until I stop on a MoonBoard, and applies in a session', () => {
    expect(DEFAULT_KEEP_LIGHTING).toBe('45');
    expect(DEFAULT_MOONBOARD_KEEP_LIGHTING).toBe('until_stopped');
    expect(DEFAULT_SETTINGS).toMatchObject({
      putOnBoardKeepsLighting: '45',
      moonboardPutOnBoardKeepsLighting: 'until_stopped',
      putOnBoardDrivesInSession: true,
    });
  });

  it('reads back a known choice, and anything else as the default', () => {
    for (const choice of KEEP_LIGHTING_CHOICES) expect(sanitiseKeepLighting(choice, '45')).toBe(choice);
    expect(sanitiseKeepLighting('90', '45')).toBe('45');
    expect(sanitiseKeepLighting(45, '45')).toBe('45');
    expect(sanitiseKeepLighting(true, 'until_stopped')).toBe('until_stopped');
    expect(sanitiseKeepLighting(null, 'off')).toBe('off');
  });

  it('offers Right away, 30 s, 45 s, 1 min, 2 min, 5 min and Until I stop, in that order', () => {
    expect(KEEP_LIGHTING_CHOICES).toEqual(['off', '30', '45', '60', '120', '300', 'until_stopped']);
  });

  it('gives each choice its drive: none for Right away, no end for Until I stop', () => {
    expect(KEEP_LIGHTING_CHOICES.map((choice) => keepLightingWindowMs(choice))).toEqual([
      undefined,
      30_000,
      45_000,
      60_000,
      120_000,
      300_000,
      null,
    ]);
  });
});

describe('resolveKeepLightingPlan', () => {
  const BASE = {
    boardIsMoonboard: false,
    keepLighting: '45',
    moonboardKeepLighting: 'until_stopped',
    drivesInSession: true,
    inSession: false,
  } as const;

  it.each<[string, Partial<Parameters<typeof resolveKeepLightingPlan>[0]>, ReturnType<typeof resolveKeepLightingPlan>]>(
    [
      ['solo', {}, { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' }],
      ['solo, Until I stop', { keepLighting: 'until_stopped' }, { windowMs: null, setting: 'putOnBoardKeepsLighting' }],
      ['solo, Off', { keepLighting: 'off' }, null],
      ['in a session', { inSession: true }, { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' }],
      ['in a session, In a session too off', { inSession: true, drivesInSession: false }, null],
      [
        'solo, In a session too off',
        { drivesInSession: false },
        { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' },
      ],
      ['MoonBoard', { boardIsMoonboard: true }, { windowMs: null, setting: 'moonboardPutOnBoardKeepsLighting' }],
      [
        'MoonBoard in a session, In a session too off',
        { boardIsMoonboard: true, inSession: true, drivesInSession: false },
        { windowMs: null, setting: 'moonboardPutOnBoardKeepsLighting' },
      ],
      [
        'MoonBoard at 1 minute, the general choice Off',
        { boardIsMoonboard: true, moonboardKeepLighting: '60', keepLighting: 'off' },
        { windowMs: 60_000, setting: 'moonboardPutOnBoardKeepsLighting' },
      ],
      ['MoonBoard, Off', { boardIsMoonboard: true, moonboardKeepLighting: 'off' }, null],
    ],
  )('%s', (_name, change, plan) => {
    expect(resolveKeepLightingPlan({ ...BASE, ...change })).toEqual(plan);
  });
});

// Light automatically (2026-11): where it drives, and where it leaves a crew alone.
describe('alwaysDriveApplies', () => {
  const ON = {
    alwaysDrive: true,
    swipeToDriveEnabled: true,
    boardIsMoonboard: false,
    drivesInSession: false,
    inSession: false,
  };

  it.each<[string, Partial<Parameters<typeof alwaysDriveApplies>[0]>, boolean]>([
    ['solo', {}, true],
    ['solo, In a session too off', { drivesInSession: false }, true],
    ['in a crew with In a session too on', { inSession: true, drivesInSession: true }, true],
    ['in a crew with In a session too off', { inSession: true }, false],
    ['a MoonBoard in a crew with In a session too off', { inSession: true, boardIsMoonboard: true }, true],
    ['switched off', { alwaysDrive: false }, false],
    ["the swipe flag off (driving's kill switch)", { swipeToDriveEnabled: false }, false],
    [
      'the swipe flag off, on a MoonBoard in a crew',
      { swipeToDriveEnabled: false, inSession: true, boardIsMoonboard: true },
      false,
    ],
    [
      'switched off, in a crew with In a session too on',
      { alwaysDrive: false, inSession: true, drivesInSession: true },
      false,
    ],
  ])('%s', (_name, change, expected) => {
    expect(alwaysDriveApplies({ ...ON, ...change })).toBe(expected);
  });
});

describe('lockScreenPressKeepsLighting', () => {
  it.each([
    ['keeps lighting with the swipe flag on and Light automatically not driving here', true, false, true],
    ['lights one climb with the swipe flag off (the kill switch)', false, false, false],
    ['lights one climb where Light automatically drives: every pick lights already', true, true, false],
  ])('%s', (_name, swipeToDriveEnabled, alwaysDrive, expected) => {
    expect(lockScreenPressKeepsLighting({ swipeToDriveEnabled, alwaysDrive })).toBe(expected);
  });
});

// What the copy promises after Put on board: the plan read against the one
// setting it does not take.
describe('resolveKeepLightingReach', () => {
  const window45 = { windowMs: 45_000, setting: 'putOnBoardKeepsLighting' } as const;
  const window300 = { windowMs: 300_000, setting: 'putOnBoardKeepsLighting' } as const;
  const untilStopped = { windowMs: null, setting: 'moonboardPutOnBoardKeepsLighting' } as const;

  it('reads the plan as it is where Light automatically does not drive', () => {
    expect(resolveKeepLightingReach({ plan: window45, alwaysDrive: false })).toEqual({
      kind: 'window',
      seconds: 45,
    });
    expect(resolveKeepLightingReach({ plan: window300, alwaysDrive: false })).toEqual({
      kind: 'window',
      seconds: 300,
    });
    expect(resolveKeepLightingReach({ plan: untilStopped, alwaysDrive: false })).toEqual({ kind: 'until_stop' });
    expect(resolveKeepLightingReach({ plan: null, alwaysDrive: false })).toEqual({ kind: 'one_climb' });
  });

  // Light automatically drives with no end whatever Stop driving after says.
  it('promises driving until the climber stops where Light automatically drives', () => {
    expect(resolveKeepLightingReach({ plan: window45, alwaysDrive: true })).toEqual({ kind: 'until_stop' });
    expect(resolveKeepLightingReach({ plan: null, alwaysDrive: true })).toEqual({ kind: 'until_stop' });
  });
});

describe('driveLengthWords', () => {
  it('says whole minutes from one minute up, and seconds below that', () => {
    expect(driveLengthWords(30)).toEqual({ unit: 'seconds', count: 30 });
    expect(driveLengthWords(45)).toEqual({ unit: 'seconds', count: 45 });
    expect(driveLengthWords(60)).toEqual({ unit: 'minutes', count: 1 });
    expect(driveLengthWords(120)).toEqual({ unit: 'minutes', count: 2 });
    expect(driveLengthWords(300)).toEqual({ unit: 'minutes', count: 5 });
    expect(driveLengthWords(90)).toEqual({ unit: 'seconds', count: 90 });
  });
});
