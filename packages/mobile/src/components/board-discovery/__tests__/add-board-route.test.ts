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
      name: 'the gym map from the picker, which already counted the opening',
      kind: 'gym_map',
      context: { returnTo: '/(tabs)/discover', fromPicker: true },
      expected: { pathname: '/gyms', params: { returnTo: '/(tabs)/discover', from: 'picker' } },
    },
    {
      name: 'the gym map from Manage boards, which counts its own opening',
      kind: 'gym_map',
      context: {},
      expected: { pathname: '/gyms', params: {} },
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
      name: 'gym-first: My own board opens the builder preset, as a home board',
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', source: 'no_board', boardKind: 'home' },
      expected: {
        pathname: '/boards/create',
        params: { returnTo: '/(tabs)/climbs', source: 'no_board', kind: 'home', preset: '1' },
      },
    },
    {
      name: 'gym-first: A board at my gym opens the gym search',
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', source: 'onboarding', boardKind: 'gym' },
      expected: { pathname: '/boards/find-wall', params: { returnTo: '/(tabs)/climbs', source: 'onboarding' } },
    },
    {
      name: "gym-first: a gym page opens straight on that gym's walls",
      kind: 'board',
      context: { returnTo: '/(tabs)/climbs', boardKind: 'gym', gymUuid: 'gym-1' },
      expected: {
        pathname: '/boards/find-wall',
        params: { returnTo: '/(tabs)/climbs', gymUuid: 'gym-1', entry: 'gym_page' },
      },
    },
    {
      name: "gym-first: an entry that hasn't said asks Where's this board?",
      kind: 'board',
      context: { source: 'no_board', boardKind: 'ask' },
      expected: { pathname: '/boards/where', params: { source: 'no_board' } },
    },
    {
      name: 'the wall wizard ignores a board kind',
      kind: 'spraywall',
      context: { boardKind: 'gym' },
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
