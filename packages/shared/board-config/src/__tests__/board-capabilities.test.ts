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
    // The static PRODUCT capability (Swift drives Woods since #3314); consumers
    // still gate per-binary via nativeBleSupportsBoard.
    nativeBoardControl: true,
    auroraAppLink: false,
  },
  spray: {
    // A climber's own wall: the only thing it does is let climbs be set on it.
    // No LEDs and no firmware (so nothing native to drive), no vendor site, no
    // crowd grade (the setter's grade is required on publish instead), and one
    // frame per climb.
    crowdGrade: false,
    climbCreation: true,
    explicitClimbRules: false,
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

  it('withholds multi-frame climbs from Woods and spray', () => {
    // `getWoodsBluetoothPacket` throws WoodsMultiFrameError on the comma a second
    // frame introduces, so a multi-frame Woods climb would save and then refuse
    // to light the wall. Spray is a product decision instead: a wall has no
    // lights to step through, so a route/circuit has nothing to animate.
    const singleFrameOnly = SUPPORTED_BOARDS.filter((boardName) => !getBoardCapabilities(boardName).multiFrameClimbs);
    expect(singleFrameOnly.sort()).toEqual(['spray', 'woods']);
  });

  it('drives no board natively except through a Boardsesh binary, and never spray', () => {
    // The one board with no hardware at all. A true here would route a wall with
    // no LEDs to the Swift encoder and try to write a packet to nothing.
    expect(getBoardCapabilities('spray').nativeBoardControl).toBe(false);
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
