import { afterEach, describe, expect, it } from 'vitest';
import type { BoardName, HoldState, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { clearSprayWallRegistry, registerSprayWall } from '../../../lib/spray/spray-wall-registry';
import { getDifficultyIdForGradeName } from '../../../lib/grade-label';
import { getPaintRoles, computeRoleCapacity } from '../brush-roles';
import {
  authoringAngle,
  defaultAnyFeet,
  hasFootHolds,
  isSprayBoard,
  nextAnyFeetForFeetChange,
  requiresSetterGrade,
  shouldAwaitWall,
  sprayWallUuidFor,
} from '../spray-climb-rules';

// The four rules a spray wall answers differently from a catalogue board
// (#5443), plus the two things the editor gets for free and must keep getting:
// the wall's role set and the start/finish capacities.

const LAYOUT_ID = 9001;

/** A painted hold. The colours are display-only here — every rule reads `state`. */
function hold(state: HoldState) {
  return { state, color: '#000000', displayColor: '#000000' };
}

function registerWall(angle: number) {
  registerSprayWall(LAYOUT_ID, {
    wallUuid: 'wall-uuid',
    angle,
    version: 1,
    photoWidth: 1200,
    photoHeight: 1600,
    photoUrl: 'https://private.example/photo',
    photoThumbUrl: null,
    photoExpiresAt: '2026-09-15T12:15:00.000Z',
    holds: [{ id: 7, cx: 100, cy: 200, r: 18 }],
  });
}

afterEach(() => {
  clearSprayWallRegistry();
});

describe('the spray board is its own authoring branch', () => {
  it('recognises only spray', () => {
    expect(isSprayBoard('spray')).toBe(true);
    expect(isSprayBoard('kilter')).toBe(false);
    expect(isSprayBoard('woods')).toBe(false);
  });
});

describe('roles a wall paints', () => {
  it('offers all four roles, like the Aurora boards', () => {
    expect(getPaintRoles('spray')).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT']);
  });

  it('keeps the two-start, two-finish capacities', () => {
    const twoStartsTwoFinishes: LitUpHoldsMap = {
      1: hold('STARTING'),
      2: hold('STARTING'),
      3: hold('FINISH'),
      4: hold('FINISH'),
      5: hold('HAND'),
    };
    expect(computeRoleCapacity(twoStartsTwoFinishes, 5, false)).toEqual({
      STARTING: true,
      FINISH: true,
      FOOT: false,
    });
  });

  it('leaves room while only one start and one finish are placed', () => {
    const oneEach: LitUpHoldsMap = { 1: hold('STARTING'), 2: hold('FINISH') };
    expect(computeRoleCapacity(oneEach, 9, false)).toEqual({ STARTING: false, FINISH: false, FOOT: false });
  });
});

describe('the setter grade', () => {
  it('is required on a spray wall and nowhere else', () => {
    expect(requiresSetterGrade('spray')).toBe(true);
    for (const boardName of ['kilter', 'tension', 'moonboard', 'woods'] satisfies BoardName[]) {
      expect(requiresSetterGrade(boardName)).toBe(false);
    }
  });
});

describe('any feet', () => {
  it('starts on for a spray wall and off everywhere else', () => {
    expect(defaultAnyFeet('spray')).toBe(true);
    expect(defaultAnyFeet('kilter')).toBe(false);
    expect(defaultAnyFeet('woods')).toBe(false);
  });

  it('sees a foot hold in the working frame', () => {
    expect(hasFootHolds({ 1: hold('STARTING'), 2: hold('FOOT') })).toBe(true);
    expect(hasFootHolds({ 1: hold('STARTING'), 2: hold('HAND') })).toBe(false);
    expect(hasFootHolds({})).toBe(false);
  });

  it('turns off when the climb gains its first foot hold', () => {
    expect(nextAnyFeetForFeetChange(false, true, true, false)).toBe(false);
  });

  it('turns back on when the last foot hold is cleared', () => {
    expect(nextAnyFeetForFeetChange(true, false, false, false)).toBe(true);
  });

  it('leaves a hand-set switch alone while the feet do not change', () => {
    expect(nextAnyFeetForFeetChange(true, true, true, false)).toBe(true);
    expect(nextAnyFeetForFeetChange(false, false, false, false)).toBe(false);
  });

  it('does not overrule the seed on the first evaluation of a session', () => {
    expect(nextAnyFeetForFeetChange(null, true, true, false)).toBe(true);
    expect(nextAnyFeetForFeetChange(null, false, false, false)).toBe(false);
  });

  it('never reopens feet on a campus climb', () => {
    expect(nextAnyFeetForFeetChange(true, false, false, true)).toBe(false);
  });
});

describe('the wall is the angle', () => {
  it('takes the registered wall angle over the caller', () => {
    registerWall(25);
    expect(authoringAngle('spray', LAYOUT_ID, 40)).toBe(25);
  });

  it('falls back to the caller while the wall is unknown', () => {
    expect(authoringAngle('spray', LAYOUT_ID, 40)).toBe(40);
  });

  it('falls back to the caller for a wall whose payload carried no angle', () => {
    // The registry keeps `null` rather than fabricating a number for such a
    // payload, precisely so this stays a fallback and not a failed publish.
    registerSprayWall(LAYOUT_ID, {
      wallUuid: 'wall-uuid',
      angle: null,
      version: 1,
      photoWidth: 1200,
      photoHeight: 1600,
      photoUrl: 'https://private.example/photo',
      photoThumbUrl: null,
      photoExpiresAt: '2026-09-15T12:15:00.000Z',
      holds: [{ id: 7, cx: 100, cy: 200, r: 18 }],
    });
    expect(authoringAngle('spray', LAYOUT_ID, 40)).toBe(40);
  });

  it('never touches a catalogue board', () => {
    registerWall(25);
    expect(authoringAngle('kilter', LAYOUT_ID, 40)).toBe(40);
  });
});

describe('the wall uuid rides every spray write', () => {
  it('is the registered wall uuid', () => {
    registerWall(40);
    expect(sprayWallUuidFor('spray', LAYOUT_ID)).toBe('wall-uuid');
  });

  it('is absent for an unregistered wall and for a catalogue board', () => {
    expect(sprayWallUuidFor('spray', LAYOUT_ID)).toBeUndefined();
    registerWall(40);
    expect(sprayWallUuidFor('kilter', LAYOUT_ID)).toBeUndefined();
  });
});

describe('waiting for a wall', () => {
  it('holds a spinner for a wall that has not arrived', () => {
    expect(shouldAwaitWall(false, LAYOUT_ID, true)).toBe(true);
  });

  it('gives up on a wall that resolved unavailable', () => {
    expect(shouldAwaitWall(false, LAYOUT_ID, false)).toBe(false);
  });

  it('never spins for a catalogue board with no hold table', () => {
    // `useSprayWall(null)` reports `idle`, which reads as loading — a malformed
    // Kilter layout/size tuple must still reach the unavailable state.
    expect(shouldAwaitWall(false, null, true)).toBe(false);
  });

  it('never spins once the holds are in hand', () => {
    expect(shouldAwaitWall(true, LAYOUT_ID, true)).toBe(false);
  });
});

describe('the grade name a remix inherits', () => {
  it('resolves the canonical name the server actually sends', () => {
    // `Climb.difficulty` comes out of the server's `getGradeLabel`, which writes
    // "6b/V4". This is the string the fork seed has to understand.
    expect(getDifficultyIdForGradeName('6b/V4')).toBe(18);
    expect(getDifficultyIdForGradeName('7a/V6')).toBe(22);
  });

  it('refuses a display label, which names more than one grade', () => {
    // "V4" is both 6b and 6b+; guessing would re-grade the remix.
    expect(getDifficultyIdForGradeName('V4')).toBeNull();
    expect(getDifficultyIdForGradeName('6b')).toBeNull();
    expect(getDifficultyIdForGradeName('')).toBeNull();
  });
});
