// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { AURORA_BOARDS, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getBoardCapabilities, type BoardCapabilities } from '../board-capabilities';

// The whole table in one place: change a row here and the reviewer sees exactly
// which surface turns on or off.
const EXPECTED: Record<string, BoardCapabilities> = {
  kilter: { crowdGrade: true, climbCreation: true, nativeBoardControl: true, auroraAppLink: true },
  tension: { crowdGrade: true, climbCreation: true, nativeBoardControl: true, auroraAppLink: true },
  decoy: { crowdGrade: true, climbCreation: true, nativeBoardControl: true, auroraAppLink: true },
  touchstone: {
    crowdGrade: true,
    climbCreation: true,
    nativeBoardControl: true,
    auroraAppLink: true,
  },
  grasshopper: {
    crowdGrade: true,
    climbCreation: true,
    nativeBoardControl: true,
    auroraAppLink: true,
  },
  soill: { crowdGrade: true, climbCreation: true, nativeBoardControl: true, auroraAppLink: true },
  moonboard: {
    crowdGrade: false,
    climbCreation: true,
    nativeBoardControl: true,
    auroraAppLink: false,
  },
  woods: {
    crowdGrade: false,
    climbCreation: false,
    nativeBoardControl: false,
    auroraAppLink: false,
  },
};

describe('getBoardCapabilities', () => {
  it.each(Object.entries(EXPECTED))('answers the whole table for %s', (boardName, capabilities) => {
    expect(getBoardCapabilities(boardName)).toEqual(capabilities);
  });

  it('covers every supported board', () => {
    // A new board in SUPPORTED_BOARDS without a row here would silently inherit
    // the Aurora defaults — every feature on, including ones it can't do.
    expect(Object.keys(EXPECTED).sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });

  it('gives every Aurora board the full feature set', () => {
    for (const auroraBoard of AURORA_BOARDS) {
      expect(getBoardCapabilities(auroraBoard)).toEqual({
        crowdGrade: true,
        climbCreation: true,
        nativeBoardControl: true,
        auroraAppLink: true,
      });
    }
  });

  it('is case-insensitive', () => {
    // The play drawer passes the board name straight through from a climb row,
    // where it has shown up capitalised ("MoonBoard").
    expect(getBoardCapabilities('MoonBoard').crowdGrade).toBe(false);
    expect(getBoardCapabilities('Woods').climbCreation).toBe(false);
  });

  it('falls back to the Aurora defaults for an unknown or absent board', () => {
    // Today's behaviour for every caller that used to ask `boardName !== 'woods'`:
    // anything unrecognised keeps every feature on, and callers that care about a
    // missing board guard on it separately.
    const auroraDefaults = {
      crowdGrade: true,
      climbCreation: true,
      nativeBoardControl: true,
      auroraAppLink: true,
    };
    expect(getBoardCapabilities(undefined)).toEqual(auroraDefaults);
    expect(getBoardCapabilities('')).toEqual(auroraDefaults);
    expect(getBoardCapabilities('not-a-board')).toEqual(auroraDefaults);
  });
});
