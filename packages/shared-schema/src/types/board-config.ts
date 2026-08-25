// Board configuration types

export const AURORA_BOARDS = ['kilter', 'tension', 'decoy', 'touchstone', 'grasshopper', 'soill'] as const;

// All supported board types - single source of truth
export const SUPPORTED_BOARDS = [
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'woods',
] as const;

export type BoardName = (typeof SUPPORTED_BOARDS)[number];
export type AuroraBoardName = (typeof AURORA_BOARDS)[number];

export type Grade = {
  difficultyId: number;
  name: string;
};

export type Angle = {
  angle: number;
};
