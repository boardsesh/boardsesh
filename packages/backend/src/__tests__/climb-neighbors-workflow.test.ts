/**
 * The nightly neighbour workflow runs one matrix job per materialised board.
 * A board added to SUPPORTED_BOARDS (and so to CLIMB_NEIGHBOR_BOARDS) without a
 * matrix entry would never get similar climbs; this pins the two together.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { CLIMB_NEIGHBOR_BOARDS } from '@boardsesh/db/queries';

const workflow = readFileSync(
  new URL('../../../../.github/workflows/refresh-climb-neighbors.yml', import.meta.url),
  'utf8',
);

describe('refresh-climb-neighbors.yml', () => {
  it('has one matrix job per materialised board, and none for spray', () => {
    const match = /^\s+board: \[([^\]]*)\]$/m.exec(workflow);
    expect(match).not.toBeNull();
    const matrixBoards = (match?.[1] ?? '').split(',').map((board) => board.trim());
    expect([...matrixBoards].sort()).toEqual([...CLIMB_NEIGHBOR_BOARDS].sort());
    expect(matrixBoards).not.toContain('spray');
  });

  it('gives a long full build room and never cancels one for the next run', () => {
    expect(workflow).toMatch(/timeout-minutes: 350/);
    expect(workflow).toMatch(/group: refresh-climb-neighbors-\$\{\{ matrix\.board \}\}/);
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).toMatch(/fail-fast: false/);
  });
});
