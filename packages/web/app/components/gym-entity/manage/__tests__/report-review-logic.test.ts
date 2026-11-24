import { describe, expect, it } from 'vite-plus/test';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import {
  hasOpenReports,
  offersUseThisSetup,
  reportsToKeep,
  reviewRows,
  sortBoardsReportedFirst,
} from '../report-review-logic';

function report(overrides: Partial<DirectoryReport>): DirectoryReport {
  return {
    uuid: 'report-1',
    targetKind: 'board',
    reason: 'wrong_setup',
    status: 'open',
    routedTo: ['creator', 'gym_staff'],
    boardUuid: 'board-1',
    boardName: 'Kilter',
    gymUuid: 'gym-1',
    gymName: 'Crux',
    reporterCount: 2,
    notes: [],
    createdAt: '2026-11-01T10:00:00.000Z',
    escalatesAt: '2026-11-15T10:00:00.000Z',
    viewerRole: 'gym_staff',
    viewerIsReporter: false,
    viewerCanResolve: true,
    ...overrides,
  };
}

describe('the Reported chip and row order', () => {
  it('marks a row with waiting reports the viewer can act on', () => {
    expect(hasOpenReports({ openReportCount: 2 })).toBe(true);
    expect(hasOpenReports({ openReportCount: 0 })).toBe(false);
    expect(hasOpenReports({ openReportCount: null })).toBe(false);
    expect(hasOpenReports({})).toBe(false);
  });

  it('puts reported boards first and keeps the server order within each group', () => {
    const boards = [
      { uuid: 'a', openReportCount: 0 },
      { uuid: 'b', openReportCount: 1 },
      { uuid: 'c', openReportCount: null },
      { uuid: 'd', openReportCount: 3 },
    ];
    expect(sortBoardsReportedFirst(boards).map((board) => board.uuid)).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('the review dialog rows', () => {
  it('lists waiting reports only, with the notes and no names', () => {
    const rows = reviewRows([
      report({
        notes: [
          {
            note: 'Holds are the 2020 set',
            createdAt: '2026-11-01T10:00:00.000Z',
            reporter: { userId: 'u1', displayName: 'Ana' },
          },
        ],
      }),
      report({ uuid: 'report-2', status: 'kept' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].notes.map((note) => note.text)).toEqual(['Holds are the 2020 set']);
    expect(JSON.stringify(rows)).not.toContain('Ana');
  });

  it('dates an open report, and marks one in the admin queue as the team’s', () => {
    expect(reviewRows([report({})])[0].footnote).toBe('escalates');
    expect(reviewRows([report({ status: 'escalated', viewerCanResolve: false })])[0].footnote).toBe('team_queue');
    // A global admin reading an escalated report can close it: no footnote.
    expect(reviewRows([report({ status: 'escalated', viewerCanResolve: true })])[0].footnote).toBeNull();
    // A gym editor can't close an open report either, but the owner and admins can.
    expect(reviewRows([report({ viewerCanResolve: false })])[0].footnote).toBe('escalates');
  });
});

describe('It’s right as it is', () => {
  it('closes every waiting report the viewer may close, and nothing in the admin queue', () => {
    expect(
      reportsToKeep([
        report({ uuid: 'mine' }),
        report({ uuid: 'team', status: 'escalated', viewerCanResolve: false }),
        report({ uuid: 'closed', status: 'fixed' }),
      ]),
    ).toEqual(['mine']);
  });
});

describe('suggested setups', () => {
  // Grouping, matching and the updateBoard input are @boardsesh/directory-moderation's,
  // tested there (suggested-setups.test.ts); these check how the dialog's rows use them.
  const note = (
    suggestedSetup: { layoutId: number; sizeId: number; setIds: string; angle?: number | null } | null,
    createdAt = '2026-11-20T10:00:00.000Z',
  ) => ({ note: '', createdAt, suggestedSetup });

  it('puts the suggestions on the review row, and drops notes with no words', () => {
    const [row] = reviewRows([
      report({
        notes: [
          { note: '', createdAt: '2026-11-20T10:00:00.000Z', suggestedSetup: { layoutId: 1, sizeId: 10, setIds: '1' } },
          { note: 'Wrong size', createdAt: '2026-11-21T10:00:00.000Z' },
        ],
      }),
    ]);
    expect(row.notes.map((entry) => entry.text)).toEqual(['Wrong size']);
    expect(row.suggestions).toHaveLength(1);
  });

  it('groups equal setups on the row, the most suggested first, then the most recent', () => {
    const [row] = reviewRows([
      report({
        notes: [
          note({ layoutId: 1, sizeId: 7, setIds: '1,20' }, '2026-11-20T10:00:00.000Z'),
          note({ layoutId: 1, sizeId: 12, setIds: '1' }, '2026-11-22T10:00:00.000Z'),
          note({ layoutId: 1, sizeId: 10, setIds: '20,1' }, '2026-11-19T10:00:00.000Z'),
          note({ layoutId: 1, sizeId: 10, setIds: '1,20', angle: null }, '2026-11-19T11:00:00.000Z'),
        ],
      }),
    ]);
    expect(row.suggestions.map((group) => [group.setup.sizeId, group.count])).toEqual([
      [10, 2],
      [12, 1],
      [7, 1],
    ]);
  });

  describe('Use this setup, and "Edit it yourself"', () => {
    const board = { layoutId: 1, sizeId: 7, setIds: '20,1', angle: 40, canEdit: true };
    const rowsSuggesting = (...setups: { layoutId: number; sizeId: number; setIds: string; angle?: number | null }[]) =>
      reviewRows([report({ notes: setups.map((setup) => note(setup)) })]);

    it('shows when a suggestion differs from the setup the board has now', () => {
      expect(offersUseThisSetup(rowsSuggesting({ layoutId: 1, sizeId: 10, setIds: '1,20' }), board)).toBe(true);
    });

    it('stays hidden when every suggestion is the setup the board has now', () => {
      expect(offersUseThisSetup(rowsSuggesting({ layoutId: 1, sizeId: 7, setIds: '1,20' }), board)).toBe(false);
    });

    it('stays hidden without suggestions, for a viewer who can not edit, or without a board', () => {
      expect(offersUseThisSetup(reviewRows([report({})]), board)).toBe(false);
      const differs = rowsSuggesting({ layoutId: 1, sizeId: 10, setIds: '1,20' });
      expect(offersUseThisSetup(differs, { ...board, canEdit: false })).toBe(false);
      expect(offersUseThisSetup(differs, null)).toBe(false);
    });
  });
});
