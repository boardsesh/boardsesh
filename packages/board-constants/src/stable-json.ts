// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { BOARD_DISPLAY_ORDER } from '@boardsesh/shared-schema';

// Board keys sort in the shared display order (Aurora boards first, then the
// code-driven ones) rather than alphabetically, so a serialised all-boards map
// reads the way the rest of the app lists boards. Every other key falls through
// to the natural compare below.
const BOARD_SORT_ORDER = new Map<string, number>(BOARD_DISPLAY_ORDER.map((boardName, index) => [boardName, index]));

function compareStableKeys(leftKey: string, rightKey: string): number {
  const leftBoardOrder = BOARD_SORT_ORDER.get(leftKey);
  const rightBoardOrder = BOARD_SORT_ORDER.get(rightKey);
  if (leftBoardOrder !== undefined || rightBoardOrder !== undefined) {
    if (leftBoardOrder === undefined) return 1;
    if (rightBoardOrder === undefined) return -1;
    return leftBoardOrder - rightBoardOrder;
  }

  return naturalCompare(leftKey, rightKey);
}

function naturalCompare(leftKey: string, rightKey: string): number {
  const leftTokens = leftKey.match(/\d+|\D+/g) ?? [leftKey];
  const rightTokens = rightKey.match(/\d+|\D+/g) ?? [rightKey];
  const tokenCount = Math.max(leftTokens.length, rightTokens.length);

  for (let tokenIndex = 0; tokenIndex < tokenCount; tokenIndex += 1) {
    const leftToken = leftTokens[tokenIndex];
    const rightToken = rightTokens[tokenIndex];
    if (leftToken === undefined) return -1;
    if (rightToken === undefined) return 1;
    if (leftToken === rightToken) continue;

    const leftIsNumeric = /^\d+$/.test(leftToken);
    const rightIsNumeric = /^\d+$/.test(rightToken);
    if (leftIsNumeric && rightIsNumeric) {
      const leftNumber = Number(leftToken);
      const rightNumber = Number(rightToken);
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
    }

    if (leftToken < rightToken) return -1;
    if (leftToken > rightToken) return 1;
  }

  return 0;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => compareStableKeys(leftKey, rightKey))
      .map(([key, entryValue]) => [key, sortJsonValue(entryValue)] as const);

    return Object.fromEntries(entries);
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}
