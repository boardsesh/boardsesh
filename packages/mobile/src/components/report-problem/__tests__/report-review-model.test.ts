import { describe, expect, it } from 'vitest';
import type { DirectoryReport } from '@boardsesh/shared-schema';
import {
  keepableReports,
  reviewFootnote,
  reviewNotes,
  suggestedSetupGroups,
  suggestedSetupUpdateInput,
  waitingReports,
} from '../report-review-model';

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

describe('suggested setups', () => {
  const current = { layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
  const note = (
    setup: { layoutId: number; sizeId: number; setIds: string; angle?: number | null } | null,
    at: string,
  ) => ({
    note: '',
    createdAt: at,
    reporter: null,
    suggestedSetup: setup,
  });

  it('groups equal setups across reports, most suggested first, then the latest', () => {
    const groups = suggestedSetupGroups(
      [
        report({
          uuid: 'r1',
          notes: [
            note({ layoutId: 1, sizeId: 7, setIds: '1', angle: null }, '2026-11-20T10:00:00.000Z'),
            note({ layoutId: 8, sizeId: 17, setIds: '27,26', angle: null }, '2026-11-21T10:00:00.000Z'),
          ],
        }),
        report({
          uuid: 'r2',
          notes: [
            note({ layoutId: 8, sizeId: 17, setIds: '26,27' }, '2026-11-19T10:00:00.000Z'),
            note({ layoutId: 1, sizeId: 8, setIds: '1', angle: null }, '2026-11-22T10:00:00.000Z'),
          ],
        }),
      ],
      current,
    );
    expect(groups).toEqual([
      { key: '8:17:26,27:', setup: { layoutId: 8, sizeId: 17, setIds: '26,27', angle: null }, count: 2 },
      { key: '1:8:1:', setup: { layoutId: 1, sizeId: 8, setIds: '1', angle: null }, count: 1 },
      { key: '1:7:1:', setup: { layoutId: 1, sizeId: 7, setIds: '1', angle: null }, count: 1 },
    ]);
  });

  it("leaves out what the board already has, notes without a setup, and other reasons' notes", () => {
    const groups = suggestedSetupGroups(
      [
        report({
          notes: [
            note({ layoutId: 1, sizeId: 10, setIds: '20,1', angle: null }, '2026-11-20T10:00:00.000Z'),
            note({ layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 }, '2026-11-20T10:00:00.000Z'),
            note(null, '2026-11-20T10:00:00.000Z'),
          ],
        }),
        report({ reason: 'gone', notes: [note({ layoutId: 1, sizeId: 7, setIds: '1' }, '2026-11-20T10:00:00.000Z')] }),
      ],
      current,
    );
    expect(groups).toEqual([]);
  });

  it('keeps an angle a board that does not tilt was suggested at apart', () => {
    const groups = suggestedSetupGroups(
      [
        report({
          notes: [
            note({ layoutId: 1, sizeId: 10, setIds: '1,20', angle: 25 }, '2026-11-20T10:00:00.000Z'),
            note({ layoutId: 1, sizeId: 10, setIds: '1,20', angle: 25 }, '2026-11-21T10:00:00.000Z'),
          ],
        }),
      ],
      current,
    );
    expect(groups).toEqual([
      { key: '1:10:1,20:25', setup: { layoutId: 1, sizeId: 10, setIds: '1,20', angle: 25 }, count: 2 },
    ]);
  });

  it('turns a suggestion into the update input, the angle only when it has one', () => {
    expect(suggestedSetupUpdateInput('board-1', { layoutId: 8, sizeId: 17, setIds: '27,26', angle: null })).toEqual({
      boardUuid: 'board-1',
      layoutId: 8,
      sizeId: 17,
      setIds: '26,27',
    });
    expect(
      suggestedSetupUpdateInput(
        'board-1',
        { layoutId: 2, sizeId: 1, setIds: '2', angle: 25 },
        { allowDuplicateConfig: true },
      ),
    ).toEqual({ boardUuid: 'board-1', layoutId: 2, sizeId: 1, setIds: '2', angle: 25, allowDuplicateConfig: true });
  });

  it('shows only written notes as notes', () => {
    const notes = reviewNotes([
      report({
        notes: [
          note({ layoutId: 1, sizeId: 7, setIds: '1' }, '2026-11-20T10:00:00.000Z'),
          { note: 'Kicker is gone', createdAt: '2026-11-21T10:00:00.000Z', reporter: null },
        ],
      }),
    ]);
    expect(notes).toEqual([{ key: 'r1:1', note: 'Kicker is gone' }]);
  });
});
