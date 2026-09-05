// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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

/**
 * The order boards are listed in when something has to show or serialise them
 * all: the Aurora boards first (in `AURORA_BOARDS` order), then the code-driven
 * ones. Deliberately NOT the `SUPPORTED_BOARDS` order, which interleaves
 * `moonboard` after `tension` — that list answers "is this a board?", this one
 * answers "in what order?". Keep it a permutation of `SUPPORTED_BOARDS`
 * (enforced by board-display-order.test.ts) so a new board can't be left out.
 */
export const BOARD_DISPLAY_ORDER = [
  'kilter',
  'tension',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'moonboard',
  'woods',
] as const satisfies readonly (typeof SUPPORTED_BOARDS)[number][];

export type BoardName = (typeof SUPPORTED_BOARDS)[number];
export type AuroraBoardName = (typeof AURORA_BOARDS)[number];

export type Grade = {
  difficultyId: number;
  name: string;
};

export type Angle = {
  angle: number;
};
