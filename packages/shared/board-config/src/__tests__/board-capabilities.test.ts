import { describe, it, expect } from 'vitest';
import { AURORA_BOARDS, SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { getBoardCapabilities, type BoardCapabilities } from '../board-capabilities';

const AURORA_ROW: BoardCapabilities = {
  crowdGrade: true,
  climbCreation: true,
  explicitClimbRules: false,
  multiFrameClimbs: true,
  nativeBoardControl: true,
  auroraAppLink: true,
};

// The whole table in one place: change a row here and the reviewer sees exactly
// which surface turns on or off.
const EXPECTED: Record<string, BoardCapabilities> = {
  kilter: AURORA_ROW,
  tension: AURORA_ROW,
  decoy: AURORA_ROW,
  touchstone: AURORA_ROW,
  grasshopper: AURORA_ROW,
  soill: AURORA_ROW,
  moonboard: {
    crowdGrade: false,
    climbCreation: true,
    explicitClimbRules: false,
    multiFrameClimbs: true,
    nativeBoardControl: true,
    auroraAppLink: false,
  },
  woods: {
    crowdGrade: false,
    climbCreation: true,
    explicitClimbRules: true,
    multiFrameClimbs: false,
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
      expect(getBoardCapabilities(auroraBoard)).toEqual(AURORA_ROW);
    }
  });

  it('lets climbs be authored on every supported board', () => {
    // Woods was the last board that could be browsed but not authored on
    // (#4750). If a new board arrives that genuinely can't, give it its own row
    // above and delete this case — don't loosen it.
    for (const boardName of SUPPORTED_BOARDS) {
      expect(getBoardCapabilities(boardName).climbCreation).toBe(true);
    }
  });

  it('states both climb rules explicitly on Woods only', () => {
    const explicit = SUPPORTED_BOARDS.filter((boardName) => getBoardCapabilities(boardName).explicitClimbRules);
    expect(explicit).toEqual(['woods']);
  });

  it('withholds multi-frame climbs from Woods only', () => {
    // `getWoodsBluetoothPacket` throws WoodsMultiFrameError on the comma a second
    // frame introduces, so a multi-frame Woods climb would save and then refuse
    // to light the wall.
    const singleFrameOnly = SUPPORTED_BOARDS.filter((boardName) => !getBoardCapabilities(boardName).multiFrameClimbs);
    expect(singleFrameOnly).toEqual(['woods']);
  });

  it('is case-insensitive', () => {
    // The play drawer passes the board name straight through from a climb row,
    // where it has shown up capitalised ("MoonBoard").
    expect(getBoardCapabilities('MoonBoard').crowdGrade).toBe(false);
    expect(getBoardCapabilities('Woods').explicitClimbRules).toBe(true);
  });

  it('falls back to the Aurora defaults for an unknown or absent board', () => {
    // Today's behaviour for every caller that used to ask `boardName !== 'woods'`:
    // anything unrecognised keeps every feature on, and callers that care about a
    // missing board guard on it separately.
    expect(getBoardCapabilities(undefined)).toEqual(AURORA_ROW);
    expect(getBoardCapabilities('')).toEqual(AURORA_ROW);
    expect(getBoardCapabilities('not-a-board')).toEqual(AURORA_ROW);
  });
});
