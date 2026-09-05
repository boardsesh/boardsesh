// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, expect, it } from 'vite-plus/test';
import { stableStringify } from '../stable-json';

describe('stableStringify', () => {
  it('emits the same bytes for objects with the same values in different insertion orders', () => {
    const firstPlacementMap = {
      tension: { '1-10': { 12: 101, 2: 20 }, '1-2': { 9: 90, 1: 10 } },
      kilter: { '7-12': { b: 2, a: 1 } },
    };
    const secondPlacementMap = {
      kilter: { '7-12': { a: 1, b: 2 } },
      tension: { '1-2': { 1: 10, 9: 90 }, '1-10': { 2: 20, 12: 101 } },
    };

    expect(stableStringify(firstPlacementMap)).toBe(stableStringify(secondPlacementMap));
  });

  it('sorts board keys in the shared display order, not alphabetically', () => {
    // The iOS placement data is compared byte-for-byte between runs, so this
    // order is load-bearing: it comes from BOARD_DISPLAY_ORDER (Aurora boards
    // first, then the code-driven ones), NOT from SUPPORTED_BOARDS, which puts
    // moonboard second.
    const placementMap = { woods: 1, moonboard: 2, tension: 3, kilter: 4, soill: 5 };

    expect(stableStringify(placementMap)).toBe('{"kilter":4,"tension":3,"soill":5,"moonboard":2,"woods":1}');
  });

  it('sorts nested object keys naturally while preserving array order', () => {
    const placementMap = {
      board: {
        '1-10': [{ z: 3, y: 2 }],
        '1-2': [{ b: 1, a: 0 }],
      },
    };

    expect(stableStringify(placementMap)).toBe('{"board":{"1-2":[{"a":0,"b":1}],"1-10":[{"y":2,"z":3}]}}');
  });
});
