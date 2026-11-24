import { describe, it, expect } from 'vitest';
import {
  isSetupSuggestionAllowed,
  SETUP_CHANGE_BOARD_COOLDOWN_HOURS,
  SETUP_CHANGE_CLIMBER_WINDOW_HOURS,
  SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO,
  SETUP_CHANGES_PER_CLIMBER_PER_DAY,
  SETUP_SUGGESTION_REVIEW_REASONS,
  setupSuggestionDecision,
  setupSuggestionPreview,
  setupSuggestionWindowStarts,
  type SetupSuggestionDecisionInput,
} from '../setup-suggestion';
import type { GymListingState } from '../reasons';

const NOW = new Date('2026-11-23T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

const unclaimedGym = (overrides: Partial<SetupSuggestionDecisionInput> = {}): SetupSuggestionDecisionInput => ({
  hasGym: true,
  gymListingState: 'UNCLAIMED',
  lastClimberChangeAt: null,
  lastUndoAt: null,
  lastClimberChangeOverriddenAt: null,
  climberChangesInWindow: 0,
  now: NOW,
  ...overrides,
});

describe('the limits', () => {
  it('are the numbers the founder agreed', () => {
    expect(SETUP_CHANGE_BOARD_COOLDOWN_HOURS).toBe(24);
    expect(SETUP_CHANGE_REVIEW_DAYS_AFTER_UNDO).toBe(90);
    expect(SETUP_CHANGES_PER_CLIMBER_PER_DAY).toBe(3);
    expect(SETUP_CHANGE_CLIMBER_WINDOW_HOURS).toBe(24);
  });

  it('start their windows that long before now', () => {
    expect(setupSuggestionWindowStarts(NOW)).toEqual({
      boardChangeSince: hoursAgo(24),
      undoSince: daysAgo(90),
      climberChangesSince: hoursAgo(24),
    });
  });
});

describe('setupSuggestionDecision: the gym', () => {
  const cases: Array<{
    name: string;
    input: Partial<SetupSuggestionDecisionInput>;
    expected: ReturnType<typeof setupSuggestionDecision>;
  }> = [
    { name: 'unclaimed gym applies', input: {}, expected: { outcome: 'apply', reason: null } },
    {
      name: 'climber-listed gym applies: nobody runs it',
      input: { gymListingState: 'CLIMBER_LISTED' },
      expected: { outcome: 'apply', reason: null },
    },
    {
      name: 'gym run by the gym: its staff review',
      input: { gymListingState: 'RUN_BY_GYM' },
      expected: { outcome: 'review', reason: 'CLAIMED_GYM' },
    },
    {
      name: 'no gym: the creator reviews',
      input: { hasGym: false, gymListingState: null },
      expected: { outcome: 'review', reason: 'NO_GYM' },
    },
    {
      name: 'a gym whose state is unknown counts as no gym',
      input: { hasGym: true, gymListingState: null },
      expected: { outcome: 'review', reason: 'NO_GYM' },
    },
    {
      name: 'a stale listing state without a gym is ignored',
      input: { hasGym: false, gymListingState: 'UNCLAIMED' },
      expected: { outcome: 'review', reason: 'NO_GYM' },
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(setupSuggestionDecision(unclaimedGym(input))).toEqual(expected);
  });
});

describe('setupSuggestionDecision: the limits at an unclaimed gym', () => {
  it('sends a second change to the same board within 24 hours to review', () => {
    expect(setupSuggestionDecision(unclaimedGym({ lastClimberChangeAt: hoursAgo(23) }))).toEqual({
      outcome: 'review',
      reason: 'RECENT_CHANGE',
    });
  });

  it('applies once 24 hours have passed since the last change', () => {
    expect(setupSuggestionDecision(unclaimedGym({ lastClimberChangeAt: hoursAgo(24) }))).toEqual({
      outcome: 'apply',
      reason: null,
    });
  });

  it('sends every suggestion to review for 90 days after an undo', () => {
    expect(setupSuggestionDecision(unclaimedGym({ lastUndoAt: daysAgo(89) }))).toEqual({
      outcome: 'review',
      reason: 'RECENTLY_UNDONE',
    });
    expect(setupSuggestionDecision(unclaimedGym({ lastUndoAt: daysAgo(90) }))).toEqual({
      outcome: 'apply',
      reason: null,
    });
  });

  it('counts a climber change the board no longer has as an undo, for 90 days from the change', () => {
    expect(setupSuggestionDecision(unclaimedGym({ lastClimberChangeOverriddenAt: daysAgo(89) }))).toEqual({
      outcome: 'review',
      reason: 'RECENTLY_UNDONE',
    });
    // Overridden within the day: still RECENTLY_UNDONE, not RECENT_CHANGE.
    const overriddenToday = unclaimedGym({
      lastClimberChangeAt: hoursAgo(2),
      lastClimberChangeOverriddenAt: hoursAgo(2),
    });
    expect(setupSuggestionDecision(overriddenToday).reason).toBe('RECENTLY_UNDONE');
    expect(setupSuggestionDecision(unclaimedGym({ lastClimberChangeOverriddenAt: daysAgo(90) }))).toEqual({
      outcome: 'apply',
      reason: null,
    });
  });

  it('stops a climber at 3 changes in 24 hours', () => {
    expect(setupSuggestionDecision(unclaimedGym({ climberChangesInWindow: 2 })).outcome).toBe('apply');
    expect(setupSuggestionDecision(unclaimedGym({ climberChangesInWindow: 3 }))).toEqual({
      outcome: 'review',
      reason: 'DAILY_LIMIT',
    });
  });

  it('names the undo before the recent change, and both before the daily limit', () => {
    const everyLimit = unclaimedGym({
      lastUndoAt: hoursAgo(1),
      lastClimberChangeAt: hoursAgo(2),
      climberChangesInWindow: 5,
    });
    expect(setupSuggestionDecision(everyLimit).reason).toBe('RECENTLY_UNDONE');
    expect(setupSuggestionDecision({ ...everyLimit, lastUndoAt: null }).reason).toBe('RECENT_CHANGE');
    expect(setupSuggestionDecision({ ...everyLimit, lastUndoAt: null, lastClimberChangeAt: null }).reason).toBe(
      'DAILY_LIMIT',
    );
  });

  it('names the gym before any limit', () => {
    const limitsHit = {
      lastUndoAt: hoursAgo(1),
      lastClimberChangeAt: hoursAgo(1),
      lastClimberChangeOverriddenAt: hoursAgo(1),
      climberChangesInWindow: 9,
    };
    expect(setupSuggestionDecision(unclaimedGym({ ...limitsHit, gymListingState: 'RUN_BY_GYM' })).reason).toBe(
      'CLAIMED_GYM',
    );
    expect(setupSuggestionDecision(unclaimedGym({ ...limitsHit, hasGym: false, gymListingState: null })).reason).toBe(
      'NO_GYM',
    );
  });

  it('never returns CLASHES: only the backend can see a clash', () => {
    const states: Array<GymListingState | null> = ['UNCLAIMED', 'CLIMBER_LISTED', 'RUN_BY_GYM', null];
    for (const gymListingState of states) {
      for (const climberChangesInWindow of [0, 3]) {
        const decision = setupSuggestionDecision(
          unclaimedGym({ gymListingState, hasGym: gymListingState !== null, climberChangesInWindow }),
        );
        expect(decision.reason).not.toBe('CLASHES');
      }
    }
    expect(SETUP_SUGGESTION_REVIEW_REASONS).toContain('CLASHES');
  });
});

describe('setupSuggestionPreview', () => {
  it('words the gym half of the decision', () => {
    expect(setupSuggestionPreview({ hasGym: true, gymListingState: 'UNCLAIMED' })).toBe('applies_for_everyone');
    expect(setupSuggestionPreview({ hasGym: true, gymListingState: 'CLIMBER_LISTED' })).toBe('applies_for_everyone');
    expect(setupSuggestionPreview({ hasGym: true, gymListingState: 'RUN_BY_GYM' })).toBe('staff_review');
    expect(setupSuggestionPreview({ hasGym: false, gymListingState: null })).toBe('creator_review');
    expect(setupSuggestionPreview({ hasGym: true, gymListingState: null })).toBe('creator_review');
  });

  it('promises "for everyone" exactly when the decision would apply with no limit hit', () => {
    const gyms: Array<{ hasGym: boolean; gymListingState: GymListingState | null }> = [
      { hasGym: true, gymListingState: 'UNCLAIMED' },
      { hasGym: true, gymListingState: 'CLIMBER_LISTED' },
      { hasGym: true, gymListingState: 'RUN_BY_GYM' },
      { hasGym: false, gymListingState: null },
    ];
    for (const gym of gyms) {
      const applies = setupSuggestionDecision(unclaimedGym(gym)).outcome === 'apply';
      expect(setupSuggestionPreview(gym) === 'applies_for_everyone').toBe(applies);
    }
  });
});

describe('isSetupSuggestionAllowed', () => {
  it('allows a suggestion on "Set up wrong" only', () => {
    expect(isSetupSuggestionAllowed('wrong_setup', 'kilter')).toBe(true);
    for (const reason of ['duplicate', 'gone', 'wrong_place', 'other', 'relist_request']) {
      expect(isSetupSuggestionAllowed(reason, 'kilter')).toBe(false);
    }
  });

  it('never allows one on a spray wall', () => {
    expect(isSetupSuggestionAllowed('wrong_setup', 'spray')).toBe(false);
    expect(isSetupSuggestionAllowed('wrong_setup', 'moonboard')).toBe(true);
  });
});
