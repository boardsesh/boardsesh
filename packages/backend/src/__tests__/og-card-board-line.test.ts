import { describe, expect, it } from 'vitest';
import { describeBoardConfig } from '../services/og-card-board-line';

/**
 * The line under a climb name on a share card. Derived from the config params
 * the URL already carries, so there is no caller to blame for a bad one — which
 * means the derivation has to handle every board type the endpoint accepts,
 * including the ones whose layouts are not in the Aurora catalogue at all.
 */
describe('describeBoardConfig', () => {
  it('names the board, its layout and its size', () => {
    const line = describeBoardConfig('kilter', 1, 10);

    expect(line.startsWith('Kilter')).toBe(true);
    expect(line).toContain(' · ');
  });

  it('uses the brand spelling, not the url slug', () => {
    expect(describeBoardConfig('moonboard', 3, 1).startsWith('MoonBoard')).toBe(true);
    expect(describeBoardConfig('soill', 1, 1).startsWith('So iLL')).toBe(true);
  });

  it('drops a layout name that only repeats the board', () => {
    // MoonBoard's layouts are named "MoonBoard 2024" and friends. Printed after
    // the brand they read as a stutter, so only the part the brand does not
    // already say survives.
    const line = describeBoardConfig('moonboard', 3, 1);

    expect(line.split(' · ').filter((part) => part.toLowerCase().includes('moonboard'))).toHaveLength(1);
  });

  it('still names the board when the catalogue has no layout for it', () => {
    // Woods and MoonBoard keep their layouts outside the Aurora tables these
    // lookups read, and a spray wall has no catalogue entry at all. A shorter
    // line is fine; a throw here would 500 a card that would otherwise render.
    expect(describeBoardConfig('woods', 999, 999)).toContain('Woods');
    expect(describeBoardConfig('spray', 1, 1)).toContain('Spray');
  });

  it('falls back to the raw name for a board type it does not know', () => {
    expect(describeBoardConfig('notaboard', 1, 1)).toContain('notaboard');
  });

  it('never returns an empty line', () => {
    for (const boardName of ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill']) {
      expect(describeBoardConfig(boardName, 1, 1).length, boardName).toBeGreaterThan(0);
    }
  });
});
