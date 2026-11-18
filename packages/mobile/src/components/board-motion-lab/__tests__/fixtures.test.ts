import { describe, expect, it } from 'vitest';
import { LAB_BOARDS, buildSyntheticClimbs, climbSetsFor, findLabBoard, type SyntheticSetKind } from '../fixtures';

function placements(frames: string): Set<string> {
  return new Set([...frames.matchAll(/p(\d+)r\d+/g)].map((match) => match[1]));
}
function meanOverlap(kind: SyntheticSetKind): number {
  const climbs = buildSyntheticClimbs(findLabBoard(null), kind);
  const ratios = climbs.slice(1).map((climb, index) => {
    const before = placements(climbs[index].frames);
    const now = placements(climb.frames);
    return [...now].filter((id) => before.has(id)).length / now.size;
  });
  return ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
}

describe('lab fixtures', () => {
  it('overlap matches each set', () => {
    expect(meanOverlap('none')).toBe(0);
    expect(meanOverlap('half')).toBeGreaterThan(0.4);
    expect(meanOverlap('half')).toBeLessThan(0.7);
    expect(meanOverlap('mostly')).toBeGreaterThan(0.8);
    expect(meanOverlap('role-change')).toBe(1);
  });
  it('role-change keeps the holds but changes frames', () => {
    const climbs = buildSyntheticClimbs(findLabBoard(null), 'role-change');
    expect(climbs[1].frames).not.toBe(climbs[2].frames);
    expect(placements(climbs[1].frames)).toEqual(placements(climbs[2].frames));
  });
  it('is deterministic and sized 8 to 12 holds, 6 climbs', () => {
    const board = findLabBoard(null);
    const first = buildSyntheticClimbs(board, 'half');
    expect(buildSyntheticClimbs(board, 'half')).toEqual(first);
    expect(first).toHaveLength(6);
    for (const climb of first) expect(placements(climb.frames).size).toBeGreaterThanOrEqual(8);
  });
  it('offers five sets on every board, real first with at least 4 climbs', () => {
    for (const board of LAB_BOARDS) {
      const sets = climbSetsFor(board);
      expect(sets).toHaveLength(5);
      expect(sets[0].id).toBe('real');
      expect(sets[0].climbs.length).toBeGreaterThanOrEqual(4);
    }
  });
});
