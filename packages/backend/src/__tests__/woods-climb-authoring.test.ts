import { describe, expect, it } from 'vite-plus/test';
import { WOODS_SIZES } from '@boardsesh/board-config';
import {
  WOODS_LAYOUT_ID,
  isWoodsBoard,
  parseWoodsFrames,
  requireWoodsSizeId,
  resolveWoodsUpdateSizeId,
  storedWoodsSizeId,
  validateWoodsClimb,
} from '../graphql/resolvers/climbs/woods-authoring';

const SMALL_SIZE_ID = WOODS_SIZES['8x10'].id;
const LARGE_SIZE_ID = WOODS_SIZES['12x12'].id;

// Wire role codes (spec §6, via WOODS_WIRE_ROLE): Foot 1, Hand 2, Finish 3, Start 4.
const START_HAND_FINISH = 'p10r4p20r2p30r3';

// Hold 600 exists on the 12x12 (0-893) and does not on the 8x10 (0-484). That
// asymmetry is the whole reason Woods climbs carry a size.
const LARGE_ONLY_HOLD = 600;

// Mounting slots with no hold bolted on: 808 on the 12x12 (its neighbours 807
// and 809 are real holds), 12 on the 8x10 — which IS a hold on the 12x12, so it
// also proves the check is per-size.
const EMPTY_LARGE_SLOT = 808;
const EMPTY_SMALL_SLOT = 12;

function publishable(overrides: Partial<Parameters<typeof validateWoodsClimb>[0]> = {}) {
  return validateWoodsClimb({
    layoutId: WOODS_LAYOUT_ID,
    sizeId: LARGE_SIZE_ID,
    angle: 40,
    frames: START_HAND_FINISH,
    framesCount: 1,
    framesPace: 0,
    isDraft: false,
    ...overrides,
  });
}

describe('isWoodsBoard', () => {
  it('is true only for the Woods board', () => {
    expect(isWoodsBoard('woods')).toBe(true);
    expect(isWoodsBoard('kilter')).toBe(false);
    expect(isWoodsBoard('moonboard')).toBe(false);
  });
});

describe('requireWoodsSizeId', () => {
  it('accepts the two real Woods sizes', () => {
    expect(requireWoodsSizeId(SMALL_SIZE_ID)).toBe(SMALL_SIZE_ID);
    expect(requireWoodsSizeId(LARGE_SIZE_ID)).toBe(LARGE_SIZE_ID);
  });

  it('rejects a missing size — nothing about the hold ids can recover it later', () => {
    expect(() => requireWoodsSizeId(null)).toThrow(/must name the board size/i);
    expect(() => requireWoodsSizeId(undefined)).toThrow(/must name the board size/i);
  });

  it('rejects a size that is not a Woods board', () => {
    expect(() => requireWoodsSizeId(7)).toThrow(/Unknown Woods board size/i);
  });
});

describe('validateWoodsClimb', () => {
  it('accepts a publishable climb and reports its holds with Woods roles', () => {
    const shape = publishable();
    expect(shape.sizeId).toBe(LARGE_SIZE_ID);
    expect(shape.dimension).toBe('12x12');
    expect(shape.holds).toEqual([
      { holdId: 10, holdState: 'STARTING', roleCode: 4 },
      { holdId: 20, holdState: 'HAND', roleCode: 2 },
      { holdId: 30, holdState: 'FINISH', roleCode: 3 },
    ]);
  });

  it('rejects any layout but the single Woods one', () => {
    expect(() => publishable({ layoutId: WOODS_LAYOUT_ID + 1 })).toThrow(/live on layout/i);
  });

  it('accepts 20-70 in 5 degree steps and nothing else', () => {
    for (const angle of [20, 45, 70]) {
      expect(() => publishable({ angle })).not.toThrow();
    }
    for (const angle of [15, 22, 75, 0]) {
      expect(() => publishable({ angle })).toThrow(/5° steps/);
    }
    expect(() => publishable({ angle: null })).toThrow(/5° steps/);
  });

  it('rejects multi-frame shapes', () => {
    expect(() => publishable({ framesCount: 2 })).toThrow(/single static frame/i);
    expect(() => publishable({ framesPace: 500 })).toThrow(/frame pace must be 0/i);
    expect(() => publishable({ frames: 'p10r4p20r2,p30r3' })).toThrow(/single frame of p<hold>r<role>/);
    // `x` off-tokens are an Aurora animation feature the Woods wire format has no
    // concept of; they must not survive into a stored Woods frames string.
    expect(() => publishable({ frames: 'p10r4x10p20r2p30r3' })).toThrow(/single frame of p<hold>r<role>/);
  });

  it('rejects a role code the Woods firmware does not speak', () => {
    // 13 is a Kilter HAND code — exactly what a create screen that fell through
    // to the Aurora role table would send.
    expect(() => publishable({ frames: 'p10r13p20r2p30r3' })).toThrow(/Unknown Woods hold role 13/);
  });

  it('rejects a hold that does not exist on the selected size', () => {
    expect(() => publishable({ sizeId: LARGE_SIZE_ID, frames: `p${LARGE_ONLY_HOLD}r4p20r2p30r3` })).not.toThrow();
    expect(() => publishable({ sizeId: SMALL_SIZE_ID, frames: `p${LARGE_ONLY_HOLD}r4p20r2p30r3` })).toThrow(
      new RegExp(`Hold ${LARGE_ONLY_HOLD} does not exist on the 8x10`),
    );
  });

  it('rejects a hold id that names an empty mounting slot', () => {
    // A Woods hold id is a T-nut position, and 169 of the 12x12's 894 carry no
    // hold. 808 is one of them; 807 and 809 beside it are real (#5185).
    expect(() => publishable({ frames: 'p807r4p809r2p30r3' })).not.toThrow();
    expect(() => publishable({ frames: `p${EMPTY_LARGE_SLOT}r4p20r2p30r3` })).toThrow(
      new RegExp(`Hold ${EMPTY_LARGE_SLOT} is an empty mounting slot on the 12x12`),
    );
    // A slot empty on one wall can be a hold on the other, so the message must
    // not be reused as "does not exist".
    expect(() => publishable({ frames: `p${EMPTY_LARGE_SLOT}r4p20r2p30r3` })).not.toThrow(/does not exist/);
  });

  it('rejects a repeated hold id', () => {
    // board_climb_holds is keyed on (board, climb, hold) and inserts with ON
    // CONFLICT DO NOTHING, so a repeat would leave frames, the hold rows and the
    // fingerprint describing three different climbs.
    expect(() => publishable({ frames: 'p10r4p10r2p30r3' })).toThrow(/listed more than once/);
  });

  it('requires a start and a finish to publish, but not to draft', () => {
    expect(() => publishable({ frames: 'p10r2p20r3' })).toThrow(/needs at least one start hold/);
    expect(() => publishable({ frames: 'p10r4p20r2' })).toThrow(/needs at least one finish hold/);
    expect(() => publishable({ frames: 'p10r2', isDraft: true })).not.toThrow();
  });

  it('still requires at least one real hold on a draft', () => {
    expect(() => publishable({ frames: '', isDraft: true })).toThrow(/single frame of p<hold>r<role>/);
  });
});

describe('parseWoodsFrames', () => {
  it('keeps the authored hold order rather than re-sorting', () => {
    // The frames string is what the BLE encoder reads back, so the parse must be
    // a faithful read of it, not a normalisation.
    expect(parseWoodsFrames('p30r3p10r4', '12x12').map((hold) => hold.holdId)).toEqual([30, 10]);
  });

  it('accepts every hold of the climbs already set on real Woods walls', () => {
    // The three production 12x12 climbs pinned by the board-render regression
    // suite (#4971). The occupancy gate must not reject a climb the wall has
    // already lit.
    const shipped = [
      'p11r3p30r2p172r2p337r2p436r1p464r2p567r1p569r2p670r2p805r4p807r4p822r1p825r1p892r1',
      'p12r3p47r2p179r2p341r2p342r2p401r2p446r1p537r2p578r1p666r2p677r1p803r4p807r4p819r1p855r1',
      'p11r3p44r2p208r2p334r2p435r2p571r1p722r4p730r4p737r1p822r1p884r1',
    ];
    for (const frames of shipped) {
      expect(() => parseWoodsFrames(frames, '12x12')).not.toThrow();
    }
  });

  it('rejects an empty mounting slot on either wall', () => {
    expect(() => parseWoodsFrames(`p${EMPTY_LARGE_SLOT}r4`, '12x12')).toThrow(/empty mounting slot/);
    expect(() => parseWoodsFrames(`p${EMPTY_SMALL_SLOT}r4`, '8x10')).toThrow(/empty mounting slot/);
    // 12 is empty on the 8x10 but a real hold on the 12x12.
    expect(() => parseWoodsFrames(`p${EMPTY_SMALL_SLOT}r4`, '12x12')).not.toThrow();
  });
});

describe('storedWoodsSizeId', () => {
  it('reads the size back out of compatible_size_ids', () => {
    expect(storedWoodsSizeId([LARGE_SIZE_ID])).toBe(LARGE_SIZE_ID);
    expect(storedWoodsSizeId([SMALL_SIZE_ID])).toBe(SMALL_SIZE_ID);
  });

  it('is null for a row that has no Woods size recorded', () => {
    expect(storedWoodsSizeId(null)).toBeNull();
    expect(storedWoodsSizeId([])).toBeNull();
    expect(storedWoodsSizeId([99])).toBeNull();
  });
});

describe('resolveWoodsUpdateSizeId', () => {
  it('uses the stored size when the request says nothing', () => {
    expect(resolveWoodsUpdateSizeId({ storedSizeId: SMALL_SIZE_ID, requestedSizeId: null })).toBe(SMALL_SIZE_ID);
    expect(resolveWoodsUpdateSizeId({ storedSizeId: SMALL_SIZE_ID, requestedSizeId: undefined })).toBe(SMALL_SIZE_ID);
  });

  it('accepts a request that agrees with the stored size', () => {
    expect(resolveWoodsUpdateSizeId({ storedSizeId: LARGE_SIZE_ID, requestedSizeId: LARGE_SIZE_ID })).toBe(
      LARGE_SIZE_ID,
    );
  });

  it('rejects a request that would move the climb to the other wall', () => {
    expect(() => resolveWoodsUpdateSizeId({ storedSizeId: SMALL_SIZE_ID, requestedSizeId: LARGE_SIZE_ID })).toThrow(
      /cannot be changed/i,
    );
  });

  it('refuses to edit a row whose size was never recorded', () => {
    expect(() => resolveWoodsUpdateSizeId({ storedSizeId: null, requestedSizeId: SMALL_SIZE_ID })).toThrow(
      /no recorded board size/i,
    );
  });
});
