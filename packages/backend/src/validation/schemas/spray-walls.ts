import { z } from 'zod';
import { MAX_RING_NUMBERS, MIN_RING_NUMBERS, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import { MAX_HOLDS_PER_WALL, SPRAY_ANGLES } from '@boardsesh/board-config';
import { isSolvableAnchorQuad } from '@boardsesh/spray-wall-geometry';
import { UUIDSchema } from './primitives';

/**
 * Shape rules for the spray wall API.
 *
 * **Shape only, on purpose.** The epic decided (2026-09-14) that the server never
 * re-runs detection on a submission: it is the owner's wall, and if they want to
 * put trash on it that is their call. So what is checked here is the ring
 * contract, the caps, and that the numbers are numbers — never whether a hold
 * "looks like" a hold. Whether a hold id is alive on the version being edited
 * needs wall data and is checked in the resolver.
 *
 * The ring rule is `isValidOutlineRing` from
 * `@boardsesh/board-art-geometry/ring`, the same implementation the outline
 * editor and `hold_outline_overrides` use, so a client can never draw a
 * silhouette its own validator accepts and this one refuses. Zod's array bounds
 * sit in front of it only so the common failures come back naming themselves.
 */
const SprayOutlineRingSchema = z
  .array(z.number())
  .min(MIN_RING_NUMBERS, `An outline needs at least ${MIN_RING_NUMBERS / 2} points`)
  .max(MAX_RING_NUMBERS, `An outline may hold at most ${MAX_RING_NUMBERS / 2} points`)
  .refine((ring) => ring.length % 2 === 0, 'An outline is a flat [x, y, ...] list, so its length must be even')
  .refine(isValidOutlineRing, 'Every outline coordinate must be a finite number within 4 hold radii');

/**
 * Canonical-frame pixel coordinates.
 *
 * The ceiling is generous rather than tight: the frame is derived from the
 * version-1 photo (there are no user-entered wall dimensions), so the only thing
 * worth bounding is a value that would overflow an `integer` column or arrive as
 * a float the column would silently truncate. A hold placed off the frame is the
 * owner's problem, not a validation failure.
 */
const CanonicalPixelSchema = z.number().int().min(-100_000).max(100_000);

/**
 * GraphQL sends the enum in SCREAMING_CASE, the column stores lower case.
 * Absent means MANUAL: a hand-drawn hold is the common write and the honest
 * default for any client that predates the detector.
 */
export const SPRAY_HOLD_SOURCE_BY_WIRE_NAME = {
  MANUAL: 'manual',
  AUTO: 'auto',
} as const;

const SprayHoldSourceSchema = z
  .enum(['MANUAL', 'AUTO'])
  .nullish()
  .transform((wireName) => SPRAY_HOLD_SOURCE_BY_WIRE_NAME[wireName ?? 'MANUAL']);

/** Wire name ↔ stored value for a version's lifecycle, mirroring the pgEnum. */
export const SPRAY_VERSION_STATUS_WIRE_NAME = {
  draft: 'DRAFT',
  published: 'PUBLISHED',
  superseded: 'SUPERSEDED',
} as const;

/**
 * The four wall corners as tapped in one photo, TL/TR/BR/BL.
 *
 * Exactly four pairs, because the homography is a 4-point DLT — three is not a
 * quad and five would need a least-squares fit nobody asked for. Anchors are
 * optional at creation and required at the first reset (SW-12), which is the
 * point at which two photographs have to agree on where a hold is.
 */
export const SprayAnchorsSchema = z
  .array(z.tuple([z.number().finite(), z.number().finite()]))
  .length(4, 'Anchors are the four wall corners, in TL/TR/BR/BL order')
  // A quad with no area is the one shape-level anchor failure worth hard-rejecting,
  // because on version 1 the anchors also DEFINE the canonical frame that every
  // later version of the wall inherits. Four taps in a line would pin an 8x0
  // coordinate space on the wall for good and land every hold ever drawn on it in
  // the same pixel. The solver's identity fallback is the last line of defence,
  // not this one — by the time it fires the frame is already written.
  .refine(
    isSolvableAnchorQuad,
    'Those four corners do not enclose a wall — tap the corners of the wall in the photo, going clockwise from the top left',
  );

/**
 * Bigint primary keys arrive as GraphQL `ID!`, i.e. a string. Parse to a number
 * rather than passing the string into a `bigint` comparison, where a
 * non-numeric value would reach Postgres as a cast error instead of a clean
 * rejection.
 */
const BigIntIdSchema = z
  .union([z.string(), z.number()])
  .transform((raw) => Number(raw))
  .refine((value) => Number.isInteger(value) && value > 0, 'Not a valid id');

export const CreateSprayWallInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  // The angle list is the one the create flow offers, and a wall's angle is
  // fixed for its life — stats are keyed by angle and a spray wall does not
  // adjust — so an off-list value is a client bug, not a preference.
  angle: z
    .number()
    .int()
    .refine(
      (angle) => (SPRAY_ANGLES as readonly number[]).includes(angle),
      `A spray wall's angle must be one of ${SPRAY_ANGLES.join(', ')}`,
    ),
  description: z.string().max(2000).optional().nullable(),
  isPublic: z.boolean().optional(),
  isUnlisted: z.boolean().optional(),
  gymUuid: UUIDSchema.optional().nullable(),
  locationName: z.string().max(200).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  hideLocation: z.boolean().optional(),
  // `hasLeds` is deliberately ABSENT and must stay absent. A spray wall has no
  // firmware to encode for, and BLE suppression today is the per-row
  // `has_leds` data rather than the board type (`scanFamilyForBoard('spray')`
  // still answers 'aurora'), so the column is written false by the resolver and
  // never taken from a client. See docs/spray-walls.md.
});

export const CreateSprayWallVersionInputSchema = z.object({
  wallUuid: UUIDSchema,
  photoId: UUIDSchema,
  anchors: SprayAnchorsSchema.optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export const SprayWallHoldInputSchema = z.object({
  // Present = correct an existing hold's geometry; absent = allocate a new
  // catalogue id for it.
  id: z.number().int().positive().optional().nullable(),
  cx: CanonicalPixelSchema,
  cy: CanonicalPixelSchema,
  r: z.number().int().min(1).max(10_000),
  outline: SprayOutlineRingSchema.optional().nullable(),
  source: SprayHoldSourceSchema,
  confidence: z.number().min(0).max(1).optional().nullable(),
  movedFromHoldId: z.number().int().positive().optional().nullable(),
});

export const UpsertSprayWallHoldsInputSchema = z.object({
  wallUuid: UUIDSchema,
  versionId: BigIntIdSchema,
  // The batch cap is the per-wall cap: a client may legitimately send a whole
  // detector run at once, and the resolver still re-checks the wall's total
  // afterwards, so this bound is only here to keep a hostile payload from being
  // parsed into memory.
  holds: z
    .array(SprayWallHoldInputSchema)
    .min(1)
    .max(MAX_HOLDS_PER_WALL)
    // A repeated correction id is not a correction applied twice — each occurrence
    // becomes its OWN successor hold, so N copies of one id turn one physical hold
    // into N live ones and slip past the per-wall cap, which counts a supersede as
    // net zero. There is no reading under which sending the same hold twice in one
    // batch is meaningful, so it is rejected rather than de-duplicated.
    .refine((holds) => {
      const ids = holds.map((hold) => hold.id).filter((id): id is number => id != null);
      return new Set(ids).size === ids.length;
    }, 'The same hold id appears twice in this batch — send each hold once'),
});

export const RemoveSprayWallHoldsInputSchema = z.object({
  wallUuid: UUIDSchema,
  versionId: BigIntIdSchema,
  holdIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_HOLDS_PER_WALL)
    // Rejected for the same reason the upsert rejects them: the mutation answers
    // with `holdIds.length`, so [7, 7, 7] would report three holds removed when
    // one was, and a repeat eats batch budget without meaning anything.
    .refine((holdIds) => new Set(holdIds).size === holdIds.length, 'The same hold id appears twice in this batch'),
});

export const PublishSprayWallVersionInputSchema = z.object({
  versionId: BigIntIdSchema,
});

/**
 * One hold found in the new photo, already mapped into the wall's canonical
 * frame by the client through the draft version's homography.
 *
 * Shape only, like every other schema here — the server never re-runs detection
 * (epic decision 2026-09-14). What it adds over `SprayWallHoldInputSchema` is
 * `colour`, which exists solely to break ties in the matcher and never reaches a
 * column.
 */
export const SprayWallDetectionInputSchema = z.object({
  cx: CanonicalPixelSchema,
  cy: CanonicalPixelSchema,
  r: z.number().int().min(1).max(10_000),
  outline: SprayOutlineRingSchema.optional().nullable(),
  /**
   * A Lab triple, or Lab plus a small hue histogram. Bounded at 16 numbers
   * because a descriptor is a handful of axes and anything longer is a client
   * sending the wrong array; `colourDistance` refuses mismatched lengths anyway,
   * so a hostile one degrades to "no colour term" rather than to a wrong match.
   */
  colour: z.array(z.number().finite()).min(1).max(16).optional().nullable(),
  source: SprayHoldSourceSchema,
  confidence: z.number().min(0).max(1).optional().nullable(),
});

export const ProposeSprayWallResetInputSchema = z.object({
  wallUuid: UUIDSchema,
  versionId: BigIntIdSchema,
  // A full reset of a capped wall is the worst case and it is legitimate, so the
  // bound is the per-wall cap. Empty is legitimate too: a photo in which the
  // client found nothing proposes removing everything, which is exactly what the
  // owner needs to see before they commit it.
  detections: z.array(SprayWallDetectionInputSchema).max(MAX_HOLDS_PER_WALL),
});

const SprayWallKeptDecisionSchema = z.object({
  holdId: z.number().int().positive(),
  detection: SprayWallDetectionInputSchema.optional().nullable(),
});

const SprayWallAddedDecisionSchema = z.object({
  detection: SprayWallDetectionInputSchema,
  movedFromHoldId: z.number().int().positive().optional().nullable(),
});

/**
 * The reviewed reset.
 *
 * The three lists are disjoint by construction and the schema says so: a hold
 * cannot be both kept and removed, and a batch repeating an id would apply one
 * decision twice — which for a removal is harmless and for a keep is a second
 * outline write racing the first. Rejected rather than de-duplicated, because
 * there is no reading under which sending a hold twice is meaningful.
 *
 * The caps are the per-wall cap on each list rather than on the total: the
 * resolver counts what the wall would actually hold afterwards, which is the
 * number that matters, and a bound here only exists to keep a hostile payload
 * from being parsed into memory.
 */
export const CommitSprayWallVersionInputSchema = z
  .object({
    wallUuid: UUIDSchema,
    versionId: BigIntIdSchema,
    kept: z.array(SprayWallKeptDecisionSchema).max(MAX_HOLDS_PER_WALL),
    removed: z.array(z.number().int().positive()).max(MAX_HOLDS_PER_WALL),
    added: z.array(SprayWallAddedDecisionSchema).max(MAX_HOLDS_PER_WALL),
  })
  .refine((input) => {
    const keptIds = input.kept.map((decision) => decision.holdId);
    return new Set(keptIds).size === keptIds.length;
  }, 'The same hold is kept twice — send each hold once')
  .refine(
    (input) => new Set(input.removed).size === input.removed.length,
    'The same hold is removed twice — send each hold once',
  )
  .refine((input) => {
    const removed = new Set(input.removed);
    return input.kept.every((decision) => !removed.has(decision.holdId));
  }, 'A hold cannot be both kept and removed');

export type SprayWallDetectionInput = z.infer<typeof SprayWallDetectionInputSchema>;
export type ProposeSprayWallResetInput = z.infer<typeof ProposeSprayWallResetInputSchema>;
export type CommitSprayWallVersionInput = z.infer<typeof CommitSprayWallVersionInputSchema>;

export const UpdateSprayWallInputSchema = z
  .object({
    uuid: UUIDSchema,
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional().nullable(),
    isPublic: z.boolean().optional(),
    isUnlisted: z.boolean().optional(),
    // Explicit null detaches the wall from its gym, which is why this is nullable
    // rather than merely optional — the two mean different things here.
    gymUuid: UUIDSchema.optional().nullable(),
    angle: z
      .number()
      .int()
      .refine(
        (angle) => (SPRAY_ANGLES as readonly number[]).includes(angle),
        `A spray wall's angle must be one of ${SPRAY_ANGLES.join(', ')}`,
      )
      .optional(),
  })
  // An update that changes nothing is a client bug, and answering it with a
  // success teaches the client that its no-op worked.
  .refine(
    (input) => Object.keys(input).some((key) => key !== 'uuid'),
    'Nothing to update — pass at least one field besides the wall uuid',
  );

export type CreateSprayWallInput = z.infer<typeof CreateSprayWallInputSchema>;
export type CreateSprayWallVersionInput = z.infer<typeof CreateSprayWallVersionInputSchema>;
export type SprayWallHoldInput = z.infer<typeof SprayWallHoldInputSchema>;
export type UpsertSprayWallHoldsInput = z.infer<typeof UpsertSprayWallHoldsInputSchema>;
export type RemoveSprayWallHoldsInput = z.infer<typeof RemoveSprayWallHoldsInputSchema>;
