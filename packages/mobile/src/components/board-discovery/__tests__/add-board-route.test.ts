import { describe, expect, it } from 'vitest';
import { addBoardRoute } from '../add-board-route';

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
      name: 'the gym map, which the picker already counted',
      kind: 'gym_map',
      context: { returnTo: '/(tabs)/discover' },
      expected: { pathname: '/gyms', params: { returnTo: '/(tabs)/discover', from: 'picker' } },
    },
    {
      name: 'the wall wizard ignores a preset',
      kind: 'spraywall',
      context: { preset: '1' },
      expected: { pathname: '/boards/spray/new', params: {} },
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
