import type { GridCoordinate } from './types';

/** Upstream holdsetup IDs, not Boardsesh layout IDs. Never infer a setup from holds. */
export const BOARD_PROFILES = {
  1: { name: 'MoonBoard 2016', rows: 18 },
  15: { name: 'MoonBoard Masters 2017', rows: 18 },
  17: { name: 'MoonBoard Masters 2019', rows: 18 },
  19: { name: 'Mini MoonBoard 2020', rows: 12 },
  21: { name: 'MoonBoard 2024', rows: 18 },
  22: { name: 'Mini MoonBoard 2025', rows: 12 },
  23: { name: 'MoonBoard 2010', rows: 18 },
} as const;

export type HoldSetup = keyof typeof BOARD_PROFILES;
export type GridRows = 12 | 18;

export function boardRows(holdsetup: HoldSetup = 21): GridRows {
  if (!Object.hasOwn(BOARD_PROFILES, holdsetup)) throw new Error('Unsupported MoonBoard holdsetup');
  return BOARD_PROFILES[holdsetup].rows;
}

const positions = (rows: GridRows) => {
  const result: Partial<Record<GridCoordinate, { x: number; y: number }>> = {};
  for (let column = 0; column < 11; column++) {
    for (let row = 1; row <= rows; row++) {
      result[`${String.fromCharCode(65 + column)}${row}` as GridCoordinate] = {
        x: (column + 0.5) / 11,
        y: (rows - row + 0.5) / rows,
      };
    }
  }
  return result;
};

export const GRID_POSITIONS_BY_ROWS = { 12: positions(12), 18: positions(18) };
