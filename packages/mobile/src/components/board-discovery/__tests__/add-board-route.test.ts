import { describe, expect, it } from 'vitest';
import { addBoardRoute, builderSerialParam } from '../add-board-route';

describe('addBoardRoute', () => {
  it.each([
    {
      name: 'the builder from the picker',
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
      expected: { pathname: '/boards/create', params: { returnTo: '/(tabs)/climbs', source: 'onboarding' } },
    },
    {
      name: 'the builder preset, from "My own board"',
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', source: 'no_board', preset: '1' },
      expected: {
        pathname: '/boards/create',
        params: { returnTo: '/(tabs)/climbs', source: 'no_board', preset: '1' },
      },
    },
    {
      name: 'the wall wizard keeps the onboarding source, so a wall closes out first run',
      kind: 'spraywall',
      context: { returnTo: '/(tabs)/climbs', source: 'onboarding' },
      expected: { pathname: '/boards/spray/new', params: { returnTo: '/(tabs)/climbs', source: 'onboarding' } },
    },
    {
      name: 'the gym map from the picker, which already counted the opening',
      kind: 'gym_map',
      context: { returnTo: '/(tabs)/discover', fromPicker: true },
      expected: { pathname: '/boards/gyms', params: { returnTo: '/(tabs)/discover', from: 'picker' } },
    },
    {
      name: 'the gym map from Manage boards, which counts its own opening',
      kind: 'gym_map',
      context: {},
      expected: { pathname: '/boards/gyms', params: {} },
    },
    {
      name: 'the builder ignores fromPicker',
      kind: 'board',
      context: { fromPicker: true },
      expected: { pathname: '/boards/create', params: {} },
    },
    {
      name: 'the wall wizard ignores a preset',
      kind: 'spraywall',
      context: { preset: '1' },
      expected: { pathname: '/boards/spray/new', params: {} },
    },
    {
      name: "wizard: the + opens Where's the board?, counted as entered from the picker",
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', source: 'onboarding', wizardEntry: 'picker' },
      expected: {
        pathname: '/boards/add',
        params: { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker' },
      },
    },
    {
      name: 'wizard: Manage boards opens step 1 with no return or source',
      kind: 'board',
      context: { wizardEntry: 'manage' },
      expected: { pathname: '/boards/add', params: { entry: 'manage' } },
    },
    {
      name: 'wizard: a preset never skips step 1',
      kind: 'board',
      context: { preset: '1', wizardEntry: 'empty_state' },
      expected: { pathname: '/boards/add', params: { entry: 'empty_state' } },
    },
    {
      name: 'the wall wizard ignores a wizard entry',
      kind: 'spraywall',
      context: { wizardEntry: 'picker' },
      expected: { pathname: '/boards/spray/new', params: {} },
    },
    {
      name: 'the gym map ignores a wizard entry',
      kind: 'gym_map',
      context: { wizardEntry: 'picker' },
      expected: { pathname: '/boards/gyms', params: {} },
    },
    {
      name: 'Manage boards, with no return or source',
      kind: 'board',
      context: {},
      expected: { pathname: '/boards/create', params: {} },
    },
  ] as const)('$name', ({ kind, context, expected }) => {
    expect(addBoardRoute(kind, context)).toEqual(expected);
  });
});

describe('builderSerialParam', () => {
  it.each<{ value: string | string[] | undefined; expected: string | undefined }>([
    { value: '751737', expected: '751737' },
    { value: '  751737 ', expected: '751737' },
    { value: '', expected: undefined },
    { value: '   ', expected: undefined },
    { value: undefined, expected: undefined },
    { value: ['751737', '800001'], expected: undefined },
    { value: 'x'.repeat(101), expected: undefined },
  ])('reads $value as $expected', ({ value, expected }) => {
    expect(builderSerialParam(value)).toBe(expected);
  });
});
