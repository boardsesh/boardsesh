import { describe, expect, it, vi } from 'vitest';

vi.mock('../../analytics', () => ({ track: vi.fn() }));

const {
  parseWizardEntry,
  parseWizardPath,
  parseWizardTrail,
  trailThrough,
  wizardBoardHref,
  wizardGymBoardsHref,
  wizardGymHref,
  wizardSetupHref,
  wizardStepPosition,
  wizardWhereHref,
} = await import('../add-board-wizard');

// "Step N of M" counts the screens the climber actually sees, from the entry
// that opened the wizard: a skipped step is never counted.
describe('wizardStepPosition', () => {
  it.each([
    // The + (and Manage, the empty state, an old link): the full paths.
    { name: '+ gym: Which gym?', step: 'gym', trail: ['where'], expected: { current: 2, total: 4 } },
    { name: '+ gym: Boards at {gym}', step: 'gym_boards', trail: ['where', 'gym'], expected: { current: 3, total: 4 } },
    {
      name: '+ gym: Set up',
      step: 'setup',
      trail: ['where', 'gym', 'gym_boards'],
      expected: { current: 4, total: 4 },
    },
    {
      name: '+ gym, gym not listed, no type: Which board?',
      step: 'board',
      trail: ['where', 'gym'],
      expected: { current: 3, total: 4 },
    },
    { name: '+ home: Which board?', step: 'board', trail: ['where'], expected: { current: 2, total: 3 } },
    { name: '+ home: Set up', step: 'setup', trail: ['where', 'board'], expected: { current: 3, total: 3 } },
    // A gym page skips Where and Which gym.
    { name: 'gym page: Boards at {gym}', step: 'gym_boards', trail: [], expected: { current: 1, total: 2 } },
    { name: 'gym page: Set up', step: 'setup', trail: ['gym_boards'], expected: { current: 2, total: 2 } },
    // First run answers Where inline, so it still counts.
    { name: 'first run: Which board?', step: 'board', trail: ['where'], expected: { current: 2, total: 3 } },
    // The In range slot knows home and the type: Set up alone, uncounted.
    { name: 'In range: Set up', step: 'setup', trail: [], expected: null },
    // Step 1's total depends on the answer, so it shows none.
    { name: 'step 1', step: 'where', trail: [], expected: null },
    { name: 'the spray hand-off', step: 'spray', trail: ['where'], expected: null },
  ] as const)('$name', ({ step, trail, expected }) => {
    expect(wizardStepPosition(step, trail)).toEqual(expected);
  });
});

describe('route params', () => {
  it.each([
    { value: 'picker', expected: 'picker' },
    { value: 'gym_page', expected: 'gym_page' },
    { value: 'in_range', expected: 'in_range' },
    { value: 'somewhere', expected: 'link' },
    { value: undefined, expected: 'link' },
    { value: ['picker'], expected: 'link' },
  ])('reads entry $value as $expected', ({ value, expected }) => {
    expect(parseWizardEntry(value)).toBe(expected);
  });

  it.each([
    { value: 'gym', expected: 'gym' },
    { value: 'home', expected: 'home' },
    { value: 'spray', expected: 'spray' },
    { value: 'garage', expected: null },
    { value: undefined, expected: null },
  ])('reads path $value as $expected', ({ value, expected }) => {
    expect(parseWizardPath(value)).toBe(expected);
  });

  it('reads a trail in order, dropping steps it does not know and the spray hand-off', () => {
    expect(parseWizardTrail('where,gym,gym_boards')).toEqual(['where', 'gym', 'gym_boards']);
    expect(parseWizardTrail('where,bogus,board')).toEqual(['where', 'board']);
    expect(parseWizardTrail('spray')).toEqual([]);
    expect(parseWizardTrail('')).toEqual([]);
    expect(parseWizardTrail(undefined)).toEqual([]);
  });

  it('adds a step to a trail without changing the one it was given', () => {
    const trail = ['where'] as const;
    expect(trailThrough(trail, 'gym')).toEqual(['where', 'gym']);
    expect(trail).toEqual(['where']);
  });
});

describe('wizard hrefs', () => {
  const context = { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker' as const };

  it("opens step 1 with no trail, carrying the picker's return and source", () => {
    expect(wizardWhereHref(context)).toEqual({
      pathname: '/boards/add',
      params: { returnTo: '/(tabs)/climbs', source: 'onboarding', entry: 'picker' },
    });
  });

  it('opens Which gym? on a type, and a gym’s boards', () => {
    expect(wizardGymHref({ ...context, trail: ['where'] }, 'kilter')).toEqual({
      pathname: '/boards/add/gym',
      params: { ...context, trail: 'where', boardType: 'kilter' },
    });
    expect(wizardGymBoardsHref({ ...context, trail: ['where', 'gym'] }, 'gym-1', null)).toEqual({
      pathname: '/boards/add/gym-boards',
      params: { ...context, trail: 'where,gym', gymUuid: 'gym-1' },
    });
  });

  it('opens Which board? on its path, focusing the location for an unlisted gym', () => {
    expect(wizardBoardHref({ ...context, trail: ['where', 'gym'] }, 'gym', { focusLocation: true })).toEqual({
      pathname: '/boards/add/board',
      params: { ...context, trail: 'where,gym', path: 'gym', focusLocation: '1' },
    });
  });

  it("opens Set up on the type's most used setup, with the gym when the path has one", () => {
    expect(
      wizardSetupHref({ ...context, trail: ['where', 'board'] }, { path: 'home', boardType: 'moonboard' }),
    ).toEqual({
      pathname: '/boards/create',
      params: {
        ...context,
        trail: 'where,board',
        path: 'home',
        kind: 'home',
        preset: '1',
        presetBoardType: 'moonboard',
      },
    });
    expect(
      wizardSetupHref({ ...context, entry: 'gym_page', trail: ['gym_boards'] }, { path: 'gym', gymUuid: 'gym-1' }),
    ).toEqual({
      pathname: '/boards/create',
      params: { ...context, entry: 'gym_page', trail: 'gym_boards', path: 'gym', kind: 'gym', gymUuid: 'gym-1' },
    });
  });

  // A gym's wall is shared by everyone there: it never opens on a guessed
  // layout and size, only on its type. A home board opens on the type's most
  // used setup.
  it('presets the home path only; the gym path gets the type alone', () => {
    const gym = wizardSetupHref(
      { ...context, trail: ['where', 'gym', 'gym_boards'] },
      { path: 'gym', boardType: 'kilter', gymUuid: 'gym-1' },
    );
    expect(gym.params).toMatchObject({ boardType: 'kilter', gymUuid: 'gym-1', kind: 'gym' });
    expect(gym.params).not.toHaveProperty('preset');
    expect(gym.params).not.toHaveProperty('presetBoardType');

    const home = wizardSetupHref({ ...context, trail: ['where', 'board'] }, { path: 'home', boardType: 'kilter' });
    expect(home.params).toMatchObject({ preset: '1', presetBoardType: 'kilter', kind: 'home' });
    expect(home.params).not.toHaveProperty('boardType');
  });
});
