import { describe, expect, it } from 'vite-plus/test';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import {
  boardHasSetup,
  groupSuggestedSetups,
  hasOpenReports,
  reportsToKeep,
  reviewRows,
  setupUpdateInput,
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
  const note = (
    suggestedSetup: { layoutId: number; sizeId: number; setIds: string; angle?: number | null } | null,
  ) => ({
    note: '',
    createdAt: '2026-11-20T10:00:00.000Z',
    suggestedSetup,
  });

  it('groups equal setups, sets in any order, the most suggested first', () => {
    const groups = groupSuggestedSetups([
      note({ layoutId: 1, sizeId: 7, setIds: '1,20', angle: null }),
      note({ layoutId: 1, sizeId: 10, setIds: '20,1' }),
      note(null),
      note({ layoutId: 1, sizeId: 10, setIds: '1,20', angle: null }),
    ]);
    expect(groups.map((group) => [group.setup, group.count])).toEqual([
      [{ layoutId: 1, sizeId: 10, setIds: '1,20', angle: null }, 2],
      [{ layoutId: 1, sizeId: 7, setIds: '1,20', angle: null }, 1],
    ]);
  });

  it('keeps setups that differ only by angle apart', () => {
    expect(
      groupSuggestedSetups([
        note({ layoutId: 1, sizeId: 7, setIds: '1', angle: 40 }),
        note({ layoutId: 1, sizeId: 7, setIds: '1', angle: 45 }),
      ]),
    ).toHaveLength(2);
  });

  it('knows when the board already has the setup', () => {
    const board = { layoutId: 1, sizeId: 7, setIds: '20,1', angle: 40 };
    expect(boardHasSetup(board, { layoutId: 1, sizeId: 7, setIds: '1,20', angle: null })).toBe(true);
    expect(boardHasSetup(board, { layoutId: 1, sizeId: 7, setIds: '1,20', angle: 45 })).toBe(false);
    expect(boardHasSetup(board, { layoutId: 1, sizeId: 10, setIds: '1,20', angle: null })).toBe(false);
  });

  it('builds the updateBoard input, with an angle only for a board that does not tilt', () => {
    expect(setupUpdateInput('board-1', { layoutId: 1, sizeId: 10, setIds: '20,1', angle: null })).toEqual({
      boardUuid: 'board-1',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,20',
    });
    expect(setupUpdateInput('board-1', { layoutId: 1, sizeId: 10, setIds: '1', angle: 45 }).angle).toBe(45);
  });

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
});
