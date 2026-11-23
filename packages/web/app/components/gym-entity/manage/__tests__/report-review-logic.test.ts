import { describe, expect, it } from 'vite-plus/test';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import { hasOpenReports, reportsToKeep, reviewRows, sortBoardsReportedFirst } from '../report-review-logic';

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
