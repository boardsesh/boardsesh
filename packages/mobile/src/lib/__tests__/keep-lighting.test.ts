// After Put on board, keep lighting (2.7): the choices, how a stored value
// reads back, and which choice a press takes on which board.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_LIGHTING,
  DEFAULT_MOONBOARD_KEEP_LIGHTING,
  KEEP_LIGHTING_CHOICES,
  keepLightingSeconds,
  keepLightingWindowMs,
  resolveKeepLightingPlan,
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

  it('gives each choice its window: none for Off, no end for Until I stop', () => {
    expect(KEEP_LIGHTING_CHOICES.map((choice) => keepLightingWindowMs(choice))).toEqual([
      undefined,
      30_000,
      45_000,
      60_000,
      null,
    ]);
    expect(KEEP_LIGHTING_CHOICES.map((choice) => keepLightingSeconds(choice))).toEqual([
      0,
      30,
      45,
      60,
      Number.POSITIVE_INFINITY,
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
