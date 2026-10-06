import { z } from 'zod';
import { MAX_RING_NUMBERS, MIN_RING_NUMBERS, isValidOutlineRing } from '@boardsesh/board-art-geometry/ring';
import { MAX_HOLDS_PER_WALL, SPRAY_ANGLES } from '@boardsesh/board-config';
import { BOARD_RENDER_SETTING_BOUNDS, type BoardseshRenderSettings } from '@boardsesh/board-look';
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
 * The retired climb-edit policy (#6025). Older apps still send it, so it is
 * accepted on create and update and then ignored: only a climb's setter edits
 * it, within 24 hours of first publish (docs/spray-walls.md, "Editing a climb").
 */
const RetiredSprayClimbEditPolicySchema = z.enum(['SETTER', 'COLLABORATORS']);

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
  climbEditPolicy: RetiredSprayClimbEditPolicySchema.optional(),
  // `hasLeds` is deliberately ABSENT and must stay absent. A spray wall has no
  // firmware to encode for, and BLE suppression today is the per-row
  // `has_leds` data rather than the board type (`scanFamilyForBoard('spray')`
  // still answers 'aurora'), so the column is written false by the resolver and
  // never taken from a client. See docs/spray-walls.md.
});

/** `resetSprayWall`: the wall to clone. Everything else is copied from it server-side. */
export const ResetSprayWallInputSchema = z.object({
  wallUuid: UUIDSchema,
});

export const CreateSprayWallVersionInputSchema = z
  .object({
    wallUuid: UUIDSchema,
    photoId: UUIDSchema.optional().nullable(),
    sourceVersionId: BigIntIdSchema.optional().nullable(),
    anchors: SprayAnchorsSchema.optional().nullable(),
    notes: z.string().max(1000).optional().nullable(),
  })
  .refine((input) => (input.photoId != null) !== (input.sourceVersionId != null), {
    message: 'Choose either an uploaded photo or the current published version',
  })
  .refine((input) => input.sourceVersionId == null || input.anchors === undefined, {
    message: 'A reused photo keeps its saved corners; omit anchors',
    path: ['anchors'],
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
 * `commitSprayWallVersion`, which older apps use to publish. Only the wall and the
 * draft are read. The reset decisions are shape-checked by GraphQL and bounded
 * here so a hostile payload is not parsed into memory, then ignored: the
 * in-place reset they described is retired (docs/spray-walls.md).
 */
export const CommitSprayWallVersionInputSchema = z.object({
  wallUuid: UUIDSchema,
  versionId: BigIntIdSchema,
  kept: z.array(z.unknown()).max(MAX_HOLDS_PER_WALL),
  removed: z.array(z.unknown()).max(MAX_HOLDS_PER_WALL),
  added: z.array(z.unknown()).max(MAX_HOLDS_PER_WALL),
  fullReset: z.boolean().nullish(),
});

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
    // Accepted and ignored. Kept in the "something to update" count below, so an
    // older app flipping the retired toggle gets its wall back, not an error.
    climbEditPolicy: RetiredSprayClimbEditPolicySchema.optional(),
  })
  // An update that changes nothing is a client bug, and answering it with a
  // success teaches the client that its no-op worked.
  .refine(
    (input) => Object.keys(input).some((key) => key !== 'uuid'),
    'Nothing to update — pass at least one field besides the wall uuid',
  );

// `validateInput` reports messages, not paths, so every message names its field:
// "Too big: expected number to be <=2" alone does not say which knob was wrong.
function boundedSetting(name: string, bounds: { readonly min: number; readonly max: number }) {
  const range = `${name} must be between ${bounds.min} and ${bounds.max}`;
  return z
    .number({ error: `${name} must be a number` })
    .min(bounds.min, range)
    .max(bounds.max, range);
}

/**
 * An option NAME, not one of the options this backend was built with.
 *
 * The app ships on its own train, so it can offer an option (a new mark style)
 * before the copy of `@boardsesh/board-look` deployed here knows it, and
 * refusing it would refuse the app's own default look. Nothing on the server
 * reads these values; the app sanitises the stored look when it reads it, and a
 * name it does not know draws as that knob's default.
 */
const OPTION_NAME = /^[a-z][a-z0-9-]{0,31}$/;

function optionSetting(name: string) {
  const message = `${name} must be an option name`;
  return z.string({ error: message }).regex(OPTION_NAME, message);
}

function flagSetting(name: string) {
  return z.boolean({ error: `${name} must be true or false` });
}

/**
 * The full Aura knob bundle, every field required.
 *
 * Numbers are held to `@boardsesh/board-look`'s own slider bounds; option knobs
 * only to a well-formed name (see `optionSetting`). A knob added there fails the
 * `satisfies` below until it is added here too. Strict, because a key this does
 * not know would be stored and handed back to every client that reads the wall.
 */
const BoardseshRenderSettingsSchema = z
  .object({
    glowFalloff: optionSetting('glowFalloff'),
    glowReach: boundedSetting('glowReach', BOARD_RENDER_SETTING_BOUNDS.glowReach),
    plateauShare: boundedSetting('plateauShare', BOARD_RENDER_SETTING_BOUNDS.plateauShare),
    veil: optionSetting('veil'),
    veilOpacity: boundedSetting('veilOpacity', BOARD_RENDER_SETTING_BOUNDS.veilOpacity),
    markStyle: optionSetting('markStyle'),
    fillOpacity: boundedSetting('fillOpacity', BOARD_RENDER_SETTING_BOUNDS.fillOpacity),
    softDisc: flagSetting('softDisc'),
    smallHoldBoost: flagSetting('smallHoldBoost'),
    ledDots: flagSetting('ledDots'),
    roleGlyphs: flagSetting('roleGlyphs'),
    thumbnailStyle: optionSetting('thumbnailStyle'),
    holdShape: optionSetting('holdShape'),
  })
  .strict() satisfies z.ZodType<Record<keyof BoardseshRenderSettings, unknown>>;

/**
 * A wall's stored default look, or null to clear it.
 *
 * `mode` is `classic` or `aura` only. Mobile's per-climber preference also has
 * `default`, which means "use whatever the default is" — and a wall default IS
 * that default, so storing `default` there would point at itself.
 */
export const SprayWallRenderSettingsSchema = z
  .object({
    mode: z.enum(['classic', 'aura'], { error: "mode must be 'classic' or 'aura'" }),
    boardsesh: BoardseshRenderSettingsSchema,
  })
  .strict()
  .nullable();

export const SetSprayWallRenderSettingsInputSchema = z
  .object({
    uuid: UUIDSchema,
    // Required, not optional: null is the explicit "clear the wall default", and
    // a missing key would be a client that forgot to say which it meant.
    renderSettings: SprayWallRenderSettingsSchema,
  })
  .strict();

export type CreateSprayWallInput = z.infer<typeof CreateSprayWallInputSchema>;
export type CreateSprayWallVersionInput = z.infer<typeof CreateSprayWallVersionInputSchema>;
export type SprayWallHoldInput = z.infer<typeof SprayWallHoldInputSchema>;
export type UpsertSprayWallHoldsInput = z.infer<typeof UpsertSprayWallHoldsInputSchema>;
export type SetSprayWallRenderSettingsInput = z.infer<typeof SetSprayWallRenderSettingsInputSchema>;
export type RemoveSprayWallHoldsInput = z.infer<typeof RemoveSprayWallHoldsInputSchema>;

/**
 * The closed set of report reasons, as the GraphQL enum spells them.
 *
 * No free-text field anywhere: prose would have to be stored, read and shown to
 * an admin, and at this volume four reasons plus `OTHER` say everything a wall
 * photograph can be reported for. It also keeps a report out of the moderation
 * queue's own attack surface.
 */
export const SPRAY_WALL_REPORT_REASONS = ['INAPPROPRIATE', 'NOT_A_WALL', 'PERSONAL_INFO', 'OTHER'] as const;

export const ReportSprayWallInputSchema = z.object({
  wallUuid: UUIDSchema,
  reason: z.enum(SPRAY_WALL_REPORT_REASONS),
});

export const SetSprayWallHiddenInputSchema = z.object({
  uuid: UUIDSchema,
  hidden: z.boolean(),
});

export type ReportSprayWallInput = z.infer<typeof ReportSprayWallInputSchema>;
export type SetSprayWallHiddenInput = z.infer<typeof SetSprayWallHiddenInputSchema>;
