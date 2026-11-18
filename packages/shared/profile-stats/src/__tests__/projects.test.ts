import { describe, expect, it } from 'vitest';
import { deriveProjects, type ProjectTickEntry } from '../projects';

type Entry = ProjectTickEntry & { id: string; angle: number };

function tick(
  id: string,
  climbUuid: string,
  status: Entry['status'],
  climbedAt: string,
  {
    attemptCount = 1,
    boardType = 'kilter',
    angle = 40,
  }: { attemptCount?: number | null; boardType?: string; angle?: number } = {},
): Entry {
  return { id, climbUuid, status, climbedAt, attemptCount, boardType, angle };
}

describe('deriveProjects', () => {
  it('keeps climbs tried and never sent, the latest tried first, with every try summed', () => {
    const projects = deriveProjects([
      tick('a1', 'climb-a', 'attempt', '2026-11-10T18:00:00Z', { attemptCount: 3 }),
      tick('a2', 'climb-a', 'attempt', '2026-11-12T18:00:00Z', { attemptCount: 4, angle: 45 }),
      tick('b1', 'climb-b', 'attempt', '2026-11-14T18:00:00Z'),
    ]);
    expect(projects.map((project) => [project.latest.id, project.tries])).toEqual([
      ['b1', 1],
      ['a2', 7],
    ]);
    expect(projects[1].latest.angle).toBe(45);
  });

  it('drops a climb once any tick on it is a send or a flash, at any angle', () => {
    const projects = deriveProjects([
      tick('a1', 'climb-a', 'attempt', '2026-11-10T18:00:00Z'),
      tick('a2', 'climb-a', 'send', '2026-11-11T18:00:00Z', { angle: 30 }),
      tick('b1', 'climb-b', 'attempt', '2026-11-12T18:00:00Z'),
      tick('b2', 'climb-b', 'flash', '2026-11-01T18:00:00Z'),
    ]);
    expect(projects).toEqual([]);
  });

  it('keeps the same uuid on two boards apart', () => {
    const projects = deriveProjects([
      tick('k', 'shared-uuid', 'send', '2026-11-10T18:00:00Z'),
      tick('t', 'shared-uuid', 'attempt', '2026-11-11T18:00:00Z', { boardType: 'tension' }),
    ]);
    expect(projects.map((project) => project.latest.id)).toEqual(['t']);
  });

  it('orders equal times by board and climb, and never lets an unreadable date lead', () => {
    const projects = deriveProjects([
      tick('z', 'climb-z', 'attempt', '2026-11-10T18:00:00Z'),
      tick('a', 'climb-a', 'attempt', '2026-11-10T18:00:00Z'),
      tick('bad', 'climb-bad', 'attempt', 'not a date'),
    ]);
    expect(projects.map((project) => project.latest.id)).toEqual(['a', 'z', 'bad']);
  });

  it('counts a tick with no or a zero try count as one try', () => {
    const projects = deriveProjects([
      tick('a1', 'climb-a', 'attempt', '2026-11-10T18:00:00Z', { attemptCount: null }),
      tick('a2', 'climb-a', 'attempt', '2026-11-11T18:00:00Z', { attemptCount: 0 }),
    ]);
    expect(projects[0].tries).toBe(2);
  });
});
