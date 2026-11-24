import { describe, expect, it } from 'vitest';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import { keepableReports, reviewFootnote, reviewNotes, waitingReports } from '../report-review-model';

function report(overrides: Partial<DirectoryReport>): DirectoryReport {
  return {
    uuid: 'r1',
    targetKind: 'board',
    reason: 'wrong_setup',
    status: 'open',
    routedTo: ['creator'],
    reporterCount: 1,
    notes: [],
    createdAt: '2026-11-20T10:00:00.000Z',
    escalatesAt: '2026-12-04T10:00:00.000Z',
    viewerRole: 'creator',
    viewerIsReporter: false,
    viewerCanResolve: true,
    ...overrides,
  };
}

describe('report review model', () => {
  it('keeps only waiting reports, oldest first', () => {
    const waiting = waitingReports([
      report({ uuid: 'late', createdAt: '2026-11-22T10:00:00.000Z' }),
      report({ uuid: 'closed', status: 'kept' }),
      report({ uuid: 'early', status: 'escalated', createdAt: '2026-11-01T10:00:00.000Z' }),
    ]);
    expect(waiting.map((entry) => entry.uuid)).toEqual(['early', 'late']);
  });

  it('gives the earliest date the team steps in', () => {
    expect(
      reviewFootnote([
        report({ uuid: 'a', escalatesAt: '2026-12-06T10:00:00.000Z' }),
        report({ uuid: 'b', escalatesAt: '2026-12-04T10:00:00.000Z' }),
      ]),
    ).toEqual({ kind: 'team_date', escalatesAt: '2026-12-04T10:00:00.000Z' });
    expect(reviewFootnote([])).toBeNull();
  });

  it('says the team has it when one waiting report is theirs to close', () => {
    expect(reviewFootnote([report({ status: 'escalated', viewerCanResolve: false })])).toEqual({
      kind: 'team_looking',
    });
  });

  it('keeps only what the viewer may close, and lists notes newest first without names', () => {
    const waiting = [
      report({
        uuid: 'a',
        notes: [{ note: 'Old note', createdAt: '2026-11-20T10:00:00.000Z', reporter: null }],
      }),
      report({
        uuid: 'b',
        viewerCanResolve: false,
        notes: [{ note: 'New note', createdAt: '2026-11-21T10:00:00.000Z', reporter: null }],
      }),
    ];
    expect(keepableReports(waiting).map((entry) => entry.uuid)).toEqual(['a']);
    expect(reviewNotes(waiting).map((entry) => entry.note)).toEqual(['New note', 'Old note']);
  });
});

// Grouping, matching and the update input live in @boardsesh/directory-moderation
// (suggested-setups.test.ts); the review sheet's test covers how it uses them.
describe('suggested setups', () => {
  it('shows only written notes as notes', () => {
    const notes = reviewNotes([
      report({
        notes: [
          {
            note: '',
            createdAt: '2026-11-20T10:00:00.000Z',
            reporter: null,
            suggestedSetup: { layoutId: 1, sizeId: 7, setIds: '1', angle: null },
          },
          { note: 'Kicker is gone', createdAt: '2026-11-21T10:00:00.000Z', reporter: null },
        ],
      }),
    ]);
    expect(notes).toEqual([{ key: 'r1:1', note: 'Kicker is gone' }]);
  });
});
