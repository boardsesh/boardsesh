import { GraphQLError } from 'graphql';
import {
  WOODS_ANGLES,
  WOODS_LAYOUTS,
  WOODS_SIZES,
  getWoodsHoldGridPosition,
  woodsSizeIdToDimension,
  type WoodsBoardSize,
} from '@boardsesh/board-config';
import { HOLD_STATE_MAP, WOODS_WIRE_ROLE } from '@boardsesh/board-constants';
import { WOODS_OCCUPIED_HOLD_IDS } from '@boardsesh/board-constants/woods';
import type { HoldState } from '@boardsesh/shared-schema';

/**
 * Woods climb authoring — every rule a Woods climb has to satisfy before it can
 * be written to `board_climbs`, in one place.
 *
 * Woods is code-driven: there are no `board_placements` / `board_product_sizes`
 * rows to validate a hold against, and `populateDenormalizedColumns` bails out
 * for the board precisely because nothing in the database can re-derive its
 * denormalised columns. So the shared geometry and role tables ARE the schema
 * here, and this module is what enforces them:
 *
 *  - one layout (1), two physical sizes (1 = 8x10, 2 = 12x12);
 *  - 20°–70° in 5° steps, the range the Woods app itself offers;
 *  - one static frame — no animation, no `x` off-tokens;
 *  - every hold id present on the SELECTED size (the two walls number their
 *    holds from their own origins, so an id valid on the 12x12 is very often a
 *    different hold, or no hold at all, on the 8x10), and physically occupied —
 *    a Woods id names a mounting slot, and about a fifth of them carry no hold;
 *  - roles drawn from `WOODS_WIRE_ROLE`, so the stored frames feed the BLE
 *    encoder unchanged;
 *  - a start and a finish before it can be published.
 *
 * No BLE code is touched: this only reads the same role table the encoder does.
 */

/** Woods ships a single hold layout; every Woods climb lives on it. */
export const WOODS_LAYOUT_ID = WOODS_LAYOUTS.woods.id;

/**
 * `required_set_ids` for an authored Woods climb: the empty set.
 *
 * Woods has one synthetic hold set, so "which sets must be bolted on" is
 * genuinely nothing, and `{} <@ ARRAY[...]` is true in Postgres — a Woods climb
 * can never be filtered out by a set list. NULL would read as "not backfilled
 * yet" and `NULL <@ …` drops the row wherever the filter runs. Matches what the
 * catalog importer writes (`WOODS_REQUIRED_SET_IDS`).
 */
export const WOODS_AUTHORED_REQUIRED_SET_IDS: number[] = [];

/**
 * Wire role code → hold state, for the four codes the Woods firmware speaks.
 *
 * Built from both shared tables rather than either alone: `WOODS_WIRE_ROLE` says
 * which codes exist and `HOLD_STATE_MAP.woods` says what each means, and the
 * module refuses to load if they disagree. A silent mismatch would let a role
 * through validation and then store it with the wrong state.
 */
const WOODS_ROLE_STATES: ReadonlyMap<number, HoldState> = new Map(
  Object.values(WOODS_WIRE_ROLE).map((roleCode) => {
    const state = HOLD_STATE_MAP.woods[roleCode]?.name;
    if (!state) throw new Error(`HOLD_STATE_MAP.woods is missing Woods wire role ${roleCode}`);
    return [roleCode, state];
  }),
);

const WOODS_SIZE_IDS: ReadonlyArray<number> = Object.values(WOODS_SIZES).map((size) => size.id);

/**
 * The mounting slots that actually carry a hold, per size.
 *
 * A Woods hold id is a T-nut position, and 106 of the 8x10's 485 slots and 169
 * of the 12x12's 894 are empty — no hold, no traced silhouette, nothing to pull
 * on. `getWoodsHoldGridPosition` answers for every slot (frames consumers and
 * the renderer's ring fallback need it to), so occupancy is a separate rule, and
 * this is where it is enforced: a climb naming an empty slot would light an
 * empty bolt hole on the wall. Built once — `parseWoodsFrames` runs per mutation.
 */
const WOODS_OCCUPIED_HOLD_ID_SETS: Record<WoodsBoardSize, ReadonlySet<number>> = {
  '8x10': new Set(WOODS_OCCUPIED_HOLD_IDS['8x10']),
  '12x12': new Set(WOODS_OCCUPIED_HOLD_IDS['12x12']),
};

/** Only `p<holdId>r<roleCode>` pairs, at least one, and nothing else. */
const WOODS_FRAMES_PATTERN = /^(?:p\d+r\d+)+$/;

export type WoodsAuthoredHold = { holdId: number; holdState: HoldState; roleCode: number };

export type WoodsClimbShape = {
  sizeId: number;
  dimension: WoodsBoardSize;
  holds: WoodsAuthoredHold[];
};

function invalid(message: string): GraphQLError {
  // BAD_USER_INPUT rather than a bare Error: these are all "you sent something
  // the board can't hold", not server faults, and the create screen surfaces the
  // message verbatim.
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/** Whether this board type is the Woods board. */
export function isWoodsBoard(boardType: string): boolean {
  return boardType === 'woods';
}

/**
 * The Woods size id a request is authoring on, or a thrown error.
 *
 * `null`/omitted is only acceptable on update, where the stored size is the
 * answer — creation has to say which of the two walls the climb is on, because
 * nothing about the hold ids can tell us afterwards.
 */
export function requireWoodsSizeId(sizeId: number | null | undefined): number {
  if (sizeId == null) {
    throw invalid(`A Woods climb must name the board size it is set on (${WOODS_SIZE_IDS.join(' or ')})`);
  }
  if (!woodsSizeIdToDimension(sizeId)) {
    throw invalid(`Unknown Woods board size: ${sizeId}. Must be one of ${WOODS_SIZE_IDS.join(', ')}`);
  }
  return sizeId;
}

/** Reject any layout other than the single Woods one. */
export function assertWoodsLayout(layoutId: number): void {
  if (layoutId !== WOODS_LAYOUT_ID) {
    throw invalid(`Woods climbs live on layout ${WOODS_LAYOUT_ID}, not ${layoutId}`);
  }
}

/** Reject an angle the Woods app itself can't set (20–70 in 5° steps). */
export function assertWoodsAngle(angle: number | null | undefined): void {
  if (angle == null || !(WOODS_ANGLES as readonly number[]).includes(angle)) {
    throw invalid(
      `Woods supports ${WOODS_ANGLES[0]}–${WOODS_ANGLES[WOODS_ANGLES.length - 1]}° in 5° steps, not ${angle ?? 'no angle'}`,
    );
  }
}

/**
 * Reject anything but a single static frame.
 *
 * The Woods firmware lights one static hold set; there is no pace, no delta
 * frames, and no `x` off-token in its wire format. Rejecting the shape here also
 * keeps the duplicate gate's `frames_count = 1` precondition true for every
 * Woods row we write.
 */
export function assertWoodsSingleFrame(framesCount: number | null | undefined, framesPace: number | null | undefined) {
  if (framesCount != null && framesCount !== 1) {
    throw invalid('Woods climbs are a single static frame; multi-frame routes are not supported');
  }
  if (framesPace != null && framesPace !== 0) {
    throw invalid('Woods climbs are a single static frame; frame pace must be 0');
  }
}

/**
 * Parse and validate a Woods frames string against the selected physical size.
 *
 * Deliberately parses the raw string itself rather than going through
 * `parseFramesToHoldEntries`, which silently DROPS tokens whose role code isn't
 * in `HOLD_STATE_MAP` — exactly the input we have to reject. Duplicated hold ids
 * are rejected for the same reason: `board_climb_holds` is keyed on
 * (board, climb, hold) and inserts with ON CONFLICT DO NOTHING, so a repeated id
 * would leave `frames`, the holds rows and the fingerprint describing three
 * different climbs.
 */
export function parseWoodsFrames(frames: string, dimension: WoodsBoardSize): WoodsAuthoredHold[] {
  if (!WOODS_FRAMES_PATTERN.test(frames)) {
    throw invalid('Woods frames must be a single frame of p<hold>r<role> pairs');
  }

  const holds: WoodsAuthoredHold[] = [];
  const seenHoldIds = new Set<number>();
  for (const match of frames.matchAll(/p(\d+)r(\d+)/g)) {
    const holdId = Number(match[1]);
    const roleCode = Number(match[2]);

    const holdState = WOODS_ROLE_STATES.get(roleCode);
    if (!holdState) {
      throw invalid(`Unknown Woods hold role ${roleCode} on hold ${holdId}`);
    }
    if (!getWoodsHoldGridPosition(holdId, dimension)) {
      throw invalid(`Hold ${holdId} does not exist on the ${dimension} Woods board`);
    }
    if (!WOODS_OCCUPIED_HOLD_ID_SETS[dimension].has(holdId)) {
      throw invalid(`Hold ${holdId} is an empty mounting slot on the ${dimension} Woods board`);
    }
    if (seenHoldIds.has(holdId)) {
      throw invalid(`Hold ${holdId} is listed more than once`);
    }
    seenHoldIds.add(holdId);

    holds.push({ holdId, holdState, roleCode });
  }

  if (holds.length === 0) {
    throw invalid('A Woods climb needs at least one hold');
  }
  return holds;
}

/**
 * A published Woods climb needs somewhere to start and somewhere to top out.
 * Drafts don't: the create screen saves a draft the moment the first hold is
 * tapped, long before either exists.
 */
export function assertWoodsPublishableHolds(holds: ReadonlyArray<WoodsAuthoredHold>): void {
  if (!holds.some((hold) => hold.holdState === 'STARTING')) {
    throw invalid('A published Woods climb needs at least one start hold');
  }
  if (!holds.some((hold) => hold.holdState === 'FINISH')) {
    throw invalid('A published Woods climb needs at least one finish hold');
  }
}

/**
 * Run every Woods rule over one authoring request and return the validated
 * shape. `sizeId` is already resolved by the caller — on create from the input,
 * on update from the stored row — because "where does the size come from" is the
 * one rule that differs between the two paths.
 */
export function validateWoodsClimb(args: {
  layoutId: number;
  sizeId: number;
  angle: number | null | undefined;
  frames: string;
  framesCount: number | null | undefined;
  framesPace: number | null | undefined;
  isDraft: boolean;
}): WoodsClimbShape {
  assertWoodsLayout(args.layoutId);
  const dimension = woodsSizeIdToDimension(args.sizeId);
  if (!dimension) {
    throw invalid(`Unknown Woods board size: ${args.sizeId}. Must be one of ${WOODS_SIZE_IDS.join(', ')}`);
  }
  assertWoodsAngle(args.angle);
  assertWoodsSingleFrame(args.framesCount, args.framesPace);

  const holds = parseWoodsFrames(args.frames, dimension);
  if (!args.isDraft) assertWoodsPublishableHolds(holds);

  return { sizeId: args.sizeId, dimension, holds };
}

/**
 * The stored Woods size for an existing climb, read back from the denormalised
 * `compatible_size_ids` the create path writes. Returns null for a row that
 * predates it (or an imported row the catalog repair hasn't reached), which the
 * caller treats as "size unknown" rather than guessing a wall.
 */
export function storedWoodsSizeId(compatibleSizeIds: number[] | null | undefined): number | null {
  const sizeId = compatibleSizeIds?.find((candidate) => woodsSizeIdToDimension(candidate) !== undefined);
  return sizeId ?? null;
}

/**
 * Resolve the size an update applies to. The size is immutable: a Woods climb
 * cannot move to the other wall, because its hold ids mean different holds
 * there — the "same" climb on the 12x12 is a different climb and gets its own
 * row. A request naming a different size is rejected rather than ignored, so a
 * client bug surfaces instead of silently doing nothing.
 */
export function resolveWoodsUpdateSizeId(args: {
  storedSizeId: number | null;
  requestedSizeId: number | null | undefined;
}): number {
  const { storedSizeId, requestedSizeId } = args;
  if (storedSizeId === null) {
    // Nothing on the row says which wall this climb is on, so no hold-id check
    // we could run would mean anything. Editing it needs the catalog repair to
    // fill the size in first.
    throw invalid('This Woods climb has no recorded board size and cannot be edited yet');
  }
  if (requestedSizeId != null && requestedSizeId !== storedSizeId) {
    throw invalid("A Woods climb's board size cannot be changed; set it on the other board as a new climb");
  }
  return storedSizeId;
}
