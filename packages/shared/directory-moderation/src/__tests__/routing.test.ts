import { describe, it, expect } from 'vitest';
import { routeBoardReport, routeGymReport, type BoardReportRoutingInput } from '../routing';
import { BOARD_REPORT_REASONS_FOR_REPORTERS, GYM_REPORT_REASONS, type GymListingState } from '../reasons';

const climberBoard = (overrides: Partial<BoardReportRoutingInput> = {}): BoardReportRoutingInput => ({
  reason: 'wrong_setup',
  boardOwnedBySystem: false,
  viewerIsCreator: false,
  hasGym: true,
  gymListingState: 'RUN_BY_GYM',
  ...overrides,
});

describe('routeBoardReport: the decision-2 table', () => {
  const cases: Array<{
    name: string;
    input: Partial<BoardReportRoutingInput>;
    recipients: string[];
    escalateNow: boolean;
  }> = [
    {
      name: 'climber board, no gym',
      input: { hasGym: false, gymListingState: null },
      recipients: ['creator'],
      escalateNow: false,
    },
    {
      name: 'climber board, unclaimed gym',
      input: { gymListingState: 'UNCLAIMED' },
      recipients: ['creator'],
      escalateNow: false,
    },
    {
      name: 'climber board, climber-listed gym: its climber owner is not staff',
      input: { gymListingState: 'CLIMBER_LISTED' },
      recipients: ['creator'],
      escalateNow: false,
    },
    {
      name: 'climber board, gym run by the gym',
      input: { gymListingState: 'RUN_BY_GYM' },
      recipients: ['creator', 'gym_staff'],
      escalateNow: false,
    },
    {
      name: 'synced board, gym run by the gym',
      input: { boardOwnedBySystem: true, gymListingState: 'RUN_BY_GYM' },
      recipients: ['gym_staff'],
      escalateNow: false,
    },
    {
      name: 'synced board, unclaimed gym: admin now',
      input: { boardOwnedBySystem: true, gymListingState: 'UNCLAIMED' },
      recipients: ['admin'],
      escalateNow: true,
    },
    {
      name: 'synced board, climber-listed gym: nobody to fix it but the team',
      input: { boardOwnedBySystem: true, gymListingState: 'CLIMBER_LISTED' },
      recipients: ['admin'],
      escalateNow: true,
    },
    {
      name: 'synced board, no gym',
      input: { boardOwnedBySystem: true, hasGym: false, gymListingState: null },
      recipients: ['admin'],
      escalateNow: true,
    },
  ];

  it.each(cases)('$name', ({ input, recipients, escalateNow }) => {
    expect(routeBoardReport(climberBoard(input))).toEqual({ recipients, escalateNow });
  });

  it('a "has gym" flag without a listing state never reaches staff', () => {
    expect(routeBoardReport(climberBoard({ gymListingState: null })).recipients).toEqual(['creator']);
  });
});

describe('routeBoardReport: wrong gym or place also goes to the team at once', () => {
  const states: Array<GymListingState | null> = ['UNCLAIMED', 'CLIMBER_LISTED', 'RUN_BY_GYM', null];

  it.each(states)('climber board at a %s gym', (gymListingState) => {
    const routing = routeBoardReport(climberBoard({ reason: 'wrong_place', gymListingState }));
    expect(routing.recipients).toContain('admin');
    expect(routing.recipients).toContain('creator');
    expect(routing.escalateNow).toBe(true);
  });

  it('a synced board at a gym run by the gym: staff and the team', () => {
    expect(
      routeBoardReport(
        climberBoard({ reason: 'wrong_place', boardOwnedBySystem: true, gymListingState: 'RUN_BY_GYM' }),
      ),
    ).toEqual({ recipients: ['gym_staff', 'admin'], escalateNow: true });
  });

  it('other reasons never add the team on their own', () => {
    for (const reason of BOARD_REPORT_REASONS_FOR_REPORTERS.filter((candidate) => candidate !== 'wrong_place')) {
      expect(routeBoardReport(climberBoard({ reason })).recipients).not.toContain('admin');
    }
  });
});

describe('routeBoardReport: a report never goes back to the person who filed it', () => {
  it('a creator reporting their own board at a gym run by the gym reaches staff only', () => {
    expect(routeBoardReport(climberBoard({ viewerIsCreator: true }))).toEqual({
      recipients: ['gym_staff'],
      escalateNow: false,
    });
  });

  it('a creator reporting their own board with nobody else to tell reaches the team', () => {
    expect(routeBoardReport(climberBoard({ viewerIsCreator: true, gymListingState: 'UNCLAIMED' }))).toEqual({
      recipients: ['admin'],
      escalateNow: true,
    });
  });
});

describe('routeBoardReport: relist_request', () => {
  it('goes to the staff of the gym that removed the board, never the creator', () => {
    for (const gymListingState of ['RUN_BY_GYM', 'CLIMBER_LISTED'] as const) {
      expect(
        routeBoardReport(climberBoard({ reason: 'relist_request', viewerIsCreator: true, gymListingState })),
      ).toEqual({ recipients: ['gym_staff'], escalateNow: false });
    }
  });

  it('goes to the team when the gym is unclaimed or gone', () => {
    expect(
      routeBoardReport(climberBoard({ reason: 'relist_request', viewerIsCreator: true, gymListingState: 'UNCLAIMED' })),
    ).toEqual({ recipients: ['admin'], escalateNow: true });
    expect(
      routeBoardReport(
        climberBoard({ reason: 'relist_request', viewerIsCreator: true, hasGym: false, gymListingState: null }),
      ),
    ).toEqual({ recipients: ['admin'], escalateNow: true });
  });
});

describe('routeGymReport', () => {
  it('wrong details go to staff of a gym run by the gym', () => {
    expect(routeGymReport({ reason: 'wrong_details', gymListingState: 'RUN_BY_GYM' })).toEqual({
      recipients: ['gym_staff'],
      escalateNow: false,
    });
  });

  it('wrong details on any other gym go to the team', () => {
    for (const gymListingState of ['UNCLAIMED', 'CLIMBER_LISTED'] as const) {
      expect(routeGymReport({ reason: 'wrong_details', gymListingState })).toEqual({
        recipients: ['admin'],
        escalateNow: true,
      });
    }
  });

  it('every other gym reason goes to the team, whoever runs the gym', () => {
    for (const reason of GYM_REPORT_REASONS.filter((candidate) => candidate !== 'wrong_details')) {
      for (const gymListingState of ['UNCLAIMED', 'CLIMBER_LISTED', 'RUN_BY_GYM'] as const) {
        expect(routeGymReport({ reason, gymListingState })).toEqual({ recipients: ['admin'], escalateNow: true });
      }
    }
  });
});
