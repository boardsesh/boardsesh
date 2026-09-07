// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type Entry = { climb_uuid: string; angle: number; difficulty: number | null; climbed_at: string; uuid: string };

const ctrl = vi.hoisted(() => ({
  board: null as { logbookByClimbAngle: Map<string, Entry[]>; fetchedLogbookClimbUuids: Set<string> } | null,
  personalGrades: true,
}));

vi.mock('../use-personal-grades', () => ({
  usePersonalGradesActive: () => ctrl.personalGrades,
}));

vi.mock('@boardsesh/board-react', () => ({
  useOptionalBoardLogbook: () => ctrl.board,
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
});
