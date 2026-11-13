import type { WoodsBoardSize } from './generated/woods-led-maps-data';
export type { WoodsBoardSize } from './generated/woods-led-maps-data';

// Shared row geometry for JS hold reflection and generated native LED maps.
const repeat = (count: number, value: number): number[] => Array.from({ length: count }, () => value);

export const WOODS_ROW_LENGTHS: Record<WoodsBoardSize, number[]> = {
  '8x10': [...repeat(1, 11), ...repeat(21, 21), ...repeat(3, 11)],
  '12x12': [...repeat(3, 17), ...repeat(23, 33), ...repeat(3, 17), ...repeat(1, 17), ...repeat(1, 16)],
};
