import { describe, expect, it } from 'vite-plus/test';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import {
  adminActionsFor,
  orderAdminReports,
  outcomeForAdminAction,
  planAdminAction,
  reportAgeDays,
} from '../board-reports-actions';

function report(overrides: Partial<DirectoryReport> = {}): DirectoryReport {
  return {
    uuid: 'report-1',
    targetKind: 'board',
    reason: 'gone',
    status: 'escalated',
    routedTo: ['admin'],
    boardUuid: 'board-1',
    boardName: 'Kilter',
    gymUuid: 'gym-1',
    gymName: 'Crux',
    reporterCount: 1,
    notes: [],
    createdAt: '2026-11-01T10:00:00.000Z',
    escalatesAt: '2026-11-15T10:00:00.000Z',
    viewerRole: 'admin',
    viewerIsReporter: false,
    viewerCanResolve: true,
    ...overrides,
  };
}

describe('which actions a report offers', () => {
  it('offers delete, remove and keep on a board report at a gym', () => {
    expect(adminActionsFor(report())).toEqual(['delete_board', 'remove_from_gym', 'keep']);
  });

  it('offers no removal without a gym, or for a relist request', () => {
    expect(adminActionsFor(report({ gymUuid: null }))).toEqual(['delete_board', 'keep']);
    expect(adminActionsFor(report({ reason: 'relist_request' }))).toEqual(['delete_board', 'keep']);
  });

  it('offers hide and keep on a gym report', () => {
    expect(adminActionsFor(report({ targetKind: 'gym', reason: 'duplicate', boardUuid: null }))).toEqual([
      'hide_gym',
      'keep',
    ]);
  });

  it('offers nothing on a closed report or one the viewer cannot close', () => {
    expect(adminActionsFor(report({ status: 'kept' }))).toEqual([]);
    expect(adminActionsFor(report({ viewerCanResolve: false }))).toEqual([]);
  });
});

describe('the steps behind each action', () => {
  it('deletes the board, then closes the report as deleted', () => {
    expect(planAdminAction(report(), 'delete_board')).toEqual([
      { kind: 'delete_board', boardUuid: 'board-1' },
      { kind: 'resolve', reportUuid: 'report-1', outcome: 'deleted', note: null },
    ]);
  });

  it('removes the board from the gym it was reported at, then closes it as removed', () => {
    expect(planAdminAction(report(), 'remove_from_gym')).toEqual([
      { kind: 'detach_board', gymUuid: 'gym-1', boardUuid: 'board-1' },
      { kind: 'resolve', reportUuid: 'report-1', outcome: 'removed', note: null },
    ]);
  });

  it('hides the gym from search, then closes the report as removed', () => {
    const gymReport = report({ targetKind: 'gym', reason: 'not_a_gym', boardUuid: null });
    expect(planAdminAction(gymReport, 'hide_gym')).toEqual([
      { kind: 'hide_gym', gymUuid: 'gym-1' },
      { kind: 'resolve', reportUuid: 'report-1', outcome: 'removed', note: null },
    ]);
  });

  it('keeps with the note, and carries no note on any other close', () => {
    expect(planAdminAction(report(), 'keep', 'It is still there')).toEqual([
      { kind: 'resolve', reportUuid: 'report-1', outcome: 'kept', note: 'It is still there' },
    ]);
    expect(planAdminAction(report(), 'delete_board', 'ignored')?.[1]).toMatchObject({ note: null });
  });

  it('plans nothing for an action the report does not offer', () => {
    expect(planAdminAction(report({ targetKind: 'gym', boardUuid: null }), 'delete_board')).toBeNull();
    expect(planAdminAction(report({ status: 'fixed' }), 'keep')).toBeNull();
  });

  it('maps every action to its outcome', () => {
    expect(outcomeForAdminAction('delete_board')).toBe('deleted');
    expect(outcomeForAdminAction('remove_from_gym')).toBe('removed');
    expect(outcomeForAdminAction('hide_gym')).toBe('removed');
    expect(outcomeForAdminAction('keep')).toBe('kept');
  });
});

describe('the queue order and age', () => {
  it('puts reports sent straight to the team ahead of those that waited 14 days', () => {
    const ordered = orderAdminReports([
      report({ uuid: 'waited-old', routedTo: ['creator'] }),
      report({ uuid: 'routed', routedTo: ['creator', 'admin'] }),
      report({ uuid: 'waited-new', routedTo: ['gym_staff'] }),
    ]);
    expect(ordered.map((entry) => entry.uuid)).toEqual(['routed', 'waited-old', 'waited-new']);
  });

  it('leaves closed reports in the server order', () => {
    const closed = [
      report({ uuid: 'a', status: 'kept', routedTo: ['creator'] }),
      report({ uuid: 'b', status: 'kept' }),
    ];
    expect(orderAdminReports(closed).map((entry) => entry.uuid)).toEqual(['a', 'b']);
  });

  it('counts whole days open', () => {
    const now = new Date('2026-11-23T09:00:00.000Z');
    expect(reportAgeDays('2026-11-23T08:00:00.000Z', now)).toBe(0);
    expect(reportAgeDays('2026-11-21T10:00:00.000Z', now)).toBe(1);
    expect(reportAgeDays('2026-11-30T10:00:00.000Z', now)).toBe(0);
  });
});
