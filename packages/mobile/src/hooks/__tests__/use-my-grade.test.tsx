// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type Entry = { climb_uuid: string; angle: number; difficulty: number | null; climbed_at: string; uuid: string };

const ctrl = vi.hoisted(() => ({
  board: null as { logbookByClimbAngle: Map<string, Entry[]>; fetchedLogbookClimbUuids: Set<string> } | null,
  personalGrades: true,
  boardName: 'kilter' as string | null,
  // What the device's own ticks table answers; `undefined` = not read.
  localGrade: undefined as { difficulty: number; climbedAt: string } | null | undefined,
  localGradeEnabled: [] as boolean[],
}));

vi.mock('../use-personal-grades', () => ({
  usePersonalGradesActive: () => ctrl.personalGrades,
}));

vi.mock('../use-local-my-grade', () => ({
  useLocalMyGrade: (_climbUuid: string, _boardName: string | null, _angle: number, enabled: boolean) => {
    ctrl.localGradeEnabled.push(enabled);
    return enabled ? ctrl.localGrade : undefined;
  },
}));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => ctrl.board,
  useOptionalBoardActions: () => (ctrl.boardName ? { boardName: ctrl.boardName } : null),
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
}));

// The pure helpers are NOT stubbed here on purpose. This suite exists to prove
// the hook actually routes through them — a stub would let the very refactor it
// guards against (dropping the clamp) stay green.
import { useMyGrade } from '../use-my-grade';
import { BOULDER_SCALE_MAX_ID, BOULDER_SCALE_MIN_ID } from '@boardsesh/logbook';

const entry = (over: Partial<Entry>): Entry => ({
  climb_uuid: 'a',
  angle: 40,
  difficulty: 20,
  climbed_at: '2026-01-01T00:00:00.000Z',
  uuid: 't1',
  ...over,
});

/** Mirrors BoardProvider's index so the hook reads the same shape it does live. */
function setLogbook(entries: Entry[], fetched: string[] = ['a']) {
  const index = new Map<string, Entry[]>();
  for (const item of entries) {
    const key = `${item.climb_uuid}:${item.angle}`;
    index.set(key, [...(index.get(key) ?? []), item]);
  }
  ctrl.board = { logbookByClimbAngle: index, fetchedLogbookClimbUuids: new Set(fetched) };
}

describe('useMyGrade', () => {
  beforeEach(() => {
    ctrl.board = null;
    ctrl.personalGrades = true;
    ctrl.boardName = 'kilter';
    ctrl.localGrade = undefined;
    ctrl.localGradeEnabled = [];
  });

  it('reports none when the setting is off, whatever the logbook holds', () => {
    // Display and query read the SAME resolution and must move together: a
    // state that reverted the filter while rows kept showing your grade would
    // put a V10 row behind a V0 filter, which is the defect #4828 is about.
    setLogbook([entry({ difficulty: 27 })]);
    ctrl.personalGrades = false;
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current.status).toBe('none');
  });

  it('reports unknown outside a BoardProvider', () => {
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current.status).toBe('unknown');
  });

  it('reports unknown until this climb has actually been fetched', () => {
    // An empty bucket is ambiguous; reading it as "never graded" would flash the
    // crowd's number and then swap it (#3940).
    setLogbook([], []);
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current.status).toBe('unknown');
  });

  it('reports none when the climb is fetched but carries no graded tick', () => {
    setLogbook([entry({ difficulty: null })]);
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current.status).toBe('none');
  });

  it('returns the grade from the latest graded tick', () => {
    setLogbook([
      entry({ uuid: 'old', difficulty: 30, climbed_at: '2025-03-01T00:00:00.000Z' }),
      entry({ uuid: 'new', difficulty: 14, climbed_at: '2026-08-01T00:00:00.000Z' }),
    ]);
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current).toMatchObject({ status: 'set', difficultyId: 14 });
  });

  it('ignores a grade given at a different angle', () => {
    // Grades are per-angle: a V9 at 40° says nothing about the climb at 30°.
    // `none`, not `unknown` — the fetched set is keyed by CLIMB, so once this
    // climb is covered we hold every angle it has, and an empty 30° bucket is a
    // real answer rather than a gap.
    setLogbook([entry({ angle: 40, difficulty: 27 })]);
    const { result } = renderHook(() => useMyGrade('a', 30));
    expect(result.current.status).toBe('none');
  });

  it('clamps an off-scale legacy tick to the boulder scale', () => {
    // The server and the local SQLite mirror both clamp before they filter and
    // sort. An unclamped display half would put a row on screen reading one
    // grade while the list placed it by another — the defect #4828 closes.
    // Writes are bounded today, so only a legacy or imported row trips this.
    setLogbook([entry({ difficulty: 99 })]);
    const { result } = renderHook(() => useMyGrade('a', 40));
    expect(result.current).toMatchObject({ status: 'set', difficultyId: BOULDER_SCALE_MAX_ID });
  });

  it('clamps a negative legacy tick up to the floor, and keeps 0 a real grade', () => {
    setLogbook([entry({ difficulty: -5 })]);
    const { result: low } = renderHook(() => useMyGrade('a', 40));
    expect(low.current).toMatchObject({ status: 'set', difficultyId: BOULDER_SCALE_MIN_ID });

    // 0 is below the scale, so it clamps — but it must reach the clamp at all
    // rather than being dropped as falsy on the way.
    setLogbook([entry({ difficulty: 0 })]);
    const { result: zero } = renderHook(() => useMyGrade('a', 40));
    expect(zero.current).toMatchObject({ status: 'set', difficultyId: BOULDER_SCALE_MIN_ID });
  });

  // Offline the logbook never resolves (it is a network fetch and is not
  // persisted), while the on-device search keeps filtering and sorting by the
  // climber's grade. These fallbacks keep the label on the number that placed
  // the row.
  describe('offline fallbacks', () => {
    it('uses the search row grade while the logbook is unresolved', () => {
      setLogbook([], []);
      const { result } = renderHook(() => useMyGrade('a', 40, { rowDifficulty: 27 }));
      expect(result.current).toMatchObject({ status: 'set', difficultyId: 27, climbedAt: null });
    });

    it('treats a null row grade as a real "never graded"', () => {
      setLogbook([], []);
      const { result } = renderHook(() => useMyGrade('a', 40, { rowDifficulty: null }));
      expect(result.current.status).toBe('none');
    });

    it('clamps the row grade like every other source', () => {
      setLogbook([], []);
      const { result } = renderHook(() => useMyGrade('a', 40, { rowDifficulty: 99 }));
      expect(result.current).toMatchObject({ status: 'set', difficultyId: BOULDER_SCALE_MAX_ID });
    });

    it('lets a resolved logbook win over the row grade', () => {
      // The logbook carries an optimistic tick the moment it is saved; the row
      // is only as fresh as the last search.
      setLogbook([entry({ difficulty: 14 })]);
      const { result } = renderHook(() => useMyGrade('a', 40, { rowDifficulty: 27 }));
      expect(result.current).toMatchObject({ status: 'set', difficultyId: 14 });
    });

    it('reads the device ticks table for the drawer when nothing else resolved', () => {
      setLogbook([], []);
      ctrl.localGrade = { difficulty: 25, climbedAt: '2026-08-01T00:00:00.000Z' };
      const { result } = renderHook(() => useMyGrade('a', 40, { localFallback: true }));
      expect(result.current).toEqual({ status: 'set', difficultyId: 25, climbedAt: '2026-08-01T00:00:00.000Z' });
    });

    it('reports none when the device ticks table has no graded tick', () => {
      setLogbook([], []);
      ctrl.localGrade = null;
      const { result } = renderHook(() => useMyGrade('a', 40, { localFallback: true }));
      expect(result.current.status).toBe('none');
    });

    it('stays unknown when the device ticks table was not read', () => {
      setLogbook([], []);
      ctrl.localGrade = undefined;
      const { result } = renderHook(() => useMyGrade('a', 40, { localFallback: true }));
      expect(result.current.status).toBe('unknown');
    });

    it('never reads the device ticks table from a list row', () => {
      // One SQLite lookup per call — per-row it would be one per visible row.
      setLogbook([], []);
      renderHook(() => useMyGrade('a', 40));
      renderHook(() => useMyGrade('a', 40, { rowDifficulty: 27 }));
      expect(ctrl.localGradeEnabled.every((enabled) => !enabled)).toBe(true);
    });

    it('stops reading the device ticks table once the logbook resolves', () => {
      setLogbook([entry({ difficulty: 14 })]);
      ctrl.localGrade = { difficulty: 25, climbedAt: '2026-08-01T00:00:00.000Z' };
      const { result } = renderHook(() => useMyGrade('a', 40, { localFallback: true }));
      expect(result.current).toMatchObject({ status: 'set', difficultyId: 14 });
      expect(ctrl.localGradeEnabled.every((enabled) => !enabled)).toBe(true);
    });

    it('ignores every source when the setting is off', () => {
      setLogbook([], []);
      ctrl.personalGrades = false;
      ctrl.localGrade = { difficulty: 25, climbedAt: '2026-08-01T00:00:00.000Z' };
      const { result: row } = renderHook(() => useMyGrade('a', 40, { rowDifficulty: 27 }));
      const { result: drawer } = renderHook(() => useMyGrade('a', 40, { localFallback: true }));
      expect(row.current.status).toBe('none');
      expect(drawer.current.status).toBe('none');
    });
  });
});
