import { z } from 'zod';
import { CONFIDENCE, MAX_SEARCH_PAGE } from '@boardsesh/db/queries';
import { CLIMB_CHARACTERISTICS, TOGGLEABLE_CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

// Cap holdsFilter entries: each ANY entry becomes a LIKE scan over board_climbs.frames
// (no trigram index there), so an unbounded record is a cheap amplification vector on
// an anonymous endpoint. 300 is far above the number of holds anyone taps by hand —
// though no longer above every board's hold count, since a Woods 12x12 has 894.
const MAX_HOLD_FILTER_ENTRIES = 300;

/** One transport batch for primary-backed live climb-stat reconciliation. */
export const ClimbStatsForClimbsUuidsSchema = z.array(ExternalUUIDSchema).min(1).max(50);

/**
 * Climb validation schema (simplified for input)
 */
export const ClimbInputSchema = z.object({
  uuid: ExternalUUIDSchema,
  // Board the climb belongs to. Round-tripped through the queue so a connected
  // board can skip a climb set for a different board/layout. Nullish: older
  // clients and pre-metadata queue items omit it.
  boardType: z.string().max(50).nullish(),
  layoutId: z.number().int().positive().nullish(),
  setter_username: z
    .string()
    .max(100)
    .nullish()
    .transform((v) => v ?? ''),
  // Boardsesh user ID of the climb owner. Nullable for Aurora-synced climbs
  // that pre-date Boardsesh accounts.
  userId: z.string().max(100).nullish(),
  name: z
    .string()
    .max(200)
    .nullish()
    .transform((v) => v ?? ''),
  description: z
    .string()
    .max(2000)
    .nullish()
    .transform((v) => v ?? ''),
  frames: z
    .string()
    .max(10000)
    .nullish()
    .transform((v) => v ?? ''),
  // Controller-native route identity. QuantumBoard uses this UUID for BLE
  // activation while Boardsesh keeps its own UUID as the catalogue identity.
  // Nullish preserves queue compatibility with existing board types and older
  // clients. ExternalUUIDSchema is intentionally tolerant for upstream IDs.
  controllerRouteUuid: ExternalUUIDSchema.nullish(),
  // Live board angle; Aurora supports negative tilt. ClimbInputSchema is only
  // consumed by the presence/queue climb payload (ClimbQueueItemSchema,
  // ReportBoardClimbInputSchema) — catalogue-write schemas (SaveClimbInputSchema,
  // UpdateClimbInputSchema, SaveMoonBoardClimbInputSchema) define their own
  // angle bound independently and stay strict.
  angle: z.number().min(-90).max(90),
  ascensionist_count: z
    .number()
    .min(0)
    .nullish()
    .transform((v) => v ?? 0),
  difficulty: z
    .string()
    .max(50)
    .nullish()
    .transform((v) => v ?? ''),
  quality_average: z
    .string()
    .max(20)
    .nullish()
    .transform((v) => v ?? ''),
  // getClimbStars now emits 0-5, but keep the upper bound at 15 so queue items
  // persisted (IndexedDB) or in flight from before that change — which carry the
  // old 0-15 stars — still validate and sync instead of being rejected.
  stars: z
    .number()
    .min(0)
    .max(15)
    .nullish()
    .transform((v) => v ?? 0),
  difficulty_error: z
    .string()
    .max(50)
    .nullish()
    .transform((v) => v ?? ''),
  mirrored: z.boolean().nullish(),
  benchmark_difficulty: z.string().max(50).nullish(),
  // `is_no_match` / `characteristics` must be declared here even though nothing
  // server-side reads them: `z.object()` STRIPS undeclared keys, and `setQueue`
  // / `joinSession` persist the PARSED item (unlike the single-item mutations,
  // which discard the parse result and store the GraphQL-coerced input). Both
  // fields ride every client's selection set already, so omitting them here made
  // a full-queue sync silently erase the no-match / method badge the client had
  // just sent — the same drift class as #3927, from the server side.
  is_no_match: z.boolean().nullish(),
  // Deliberately NOT `z.enum(CLIMB_CHARACTERISTICS)`. `parseArrayTolerant` drops
  // the WHOLE queue item when its schema fails, so enum-validating here would let
  // a newer client's unknown characteristic silently delete a queue slot for
  // everyone — exactly the failure mode #3857 fixed for `uuid`. Bounded plain
  // strings give the memory-exhaustion guard without that footgun.
  characteristics: z.array(z.string().max(50)).max(20).nullish(),
  // Whether this climb is still an unpublished draft. Round-trips through
  // the queue so peers can gate the Edit affordance locally.
  is_draft: z.boolean().nullish(),
  // ISO timestamp of first publish; used by clients to enforce the 24h
  // post-publish edit window without a second round-trip.
  published_at: z.string().max(100).nullish(),
  userAscents: z.number().min(0).nullish(),
  userAttempts: z.number().min(0).nullish(),
  // Round-trip multi-frame metadata so peers don't have to refetch /climb.
  framesCount: z.number().int().min(1).nullish(),
  framesPace: z.number().int().min(0).nullish(),
  // Boardsesh grade + confidence tier, round-tripped through the queue so peers
  // render the grade without a per-climb refetch. Nullish: older clients and
  // pre-grade queue items omit them.
  boardseshDifficulty: z.number().nullish(),
  // Source of truth for the tier set: CONFIDENCE / ConfidenceTier in
  // packages/db/src/queries/grade-model/constants.ts.
  boardseshConfidence: z.enum([CONFIDENCE.confirmed, CONFIDENCE.provisional, CONFIDENCE.setterOnly]).nullish(),
  // The sizes the climb fits on, round-tripped through the queue so a peer on a
  // different-sized wall keeps the one signal that separates Woods' two boards
  // (their hold ids overlap as different holds). Bounded: a board type has a
  // handful of product sizes, never dozens.
  compatibleSizeIds: z.array(z.number().int()).max(50).nullish(),
});

/**
 * Queue item user validation schema
 */
export const QueueItemUserSchema = z.object({
  id: z.string().max(100),
  username: z.string().max(100),
  avatarUrl: z.string().max(500).nullish(),
});

/**
 * ClimbQueueItem validation schema
 */
export const ClimbQueueItemSchema = z.object({
  // Opaque client-minted queue-slot id — NOT an Aurora climb uuid (that's
  // climb.uuid below). Only needs to be unique and bounded, so it uses the
  // same lenient ExternalUUIDSchema as climb.uuid rather than strict RFC-4122
  // parsing. Historical/peer-synced queue items (and the transient
  // `playlist-peek:<uuid>` id minted client-side, see @boardsesh/queue's
  // playlist-suggestions.ts) are not always dash-formatted v4 uuids — strict
  // parsing here rejected the WHOLE queue on `setQueue` for one such item
  // (issue #3857), the same class of bug PR #419 already fixed for
  // `climb.uuid` above. RFC-strictness bought no safety: the reducer and this
  // schema only ever compare the field with `===`, never parse it.
  uuid: ExternalUUIDSchema,
  climb: ClimbInputSchema,
  addedBy: z.string().max(100).nullish(),
  addedByUser: QueueItemUserSchema.nullish(),
  tickedBy: z.array(z.string()).max(100).nullish(),
  suggested: z.boolean().nullish(),
});

/**
 * Climb search input validation schema
 */
export const ClimbSearchInputSchema = z.object({
  boardName: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
  sizeId: z.number().int().positive('Size ID must be positive'),
  setIds: z.string().min(1, 'Set IDs cannot be empty'),
  angle: z.number().int(),
  page: z.number().int().min(0).max(MAX_SEARCH_PAGE, 'Page number too large').optional(),
  pageSize: z.number().int().min(1).max(100, 'Page size cannot exceed 100').optional(),
  gradeAccuracy: z.string().optional(),
  minGrade: z.number().int().optional(),
  maxGrade: z.number().int().optional(),
  minAscents: z.number().int().min(0).optional(),
  minRating: z.number().min(0).max(5).optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  // Seed for the 'random' sort. Digits only (newSortSeed emits an integer string)
  // and bounded, so it can't bloat the md5 salt or carry anything unexpected.
  sortSeed: z.string().max(32).regex(/^\d+$/).optional(),
  name: z.string().max(200).optional(),
  setter: z.array(z.string().max(100)).optional(),
  setterId: z.number().int().optional(),
  onlyBenchmarks: z.boolean().optional(),
  onlyTallClimbs: z.boolean().optional(),
  onlyWideClimbs: z.boolean().optional(),
  onlyWithBetaVideos: z.boolean().optional(),
  // Per-hold map of type→mode filters. Each hold can carry filters for
  // multiple types (e.g. STARTING:include + FOOT:exclude). ANY means "hold
  // present in any state" (the wildcard, was the legacy `ANY`/`NOT` value).
  // Uses an explicit z.object instead of nested z.record because Zod 4's
  // two-arg z.record(keyEnum, valueEnum) emits one "expected include|exclude"
  // error per outer key when the inner record uses an enum key — the explicit
  // object form sidesteps that and is clearer about which keys are allowed.
  holdsFilter: z
    .record(
      z.string(),
      z
        .object({
          STARTING: z.enum(['include', 'exclude']).optional(),
          HAND: z.enum(['include', 'exclude']).optional(),
          FINISH: z.enum(['include', 'exclude']).optional(),
          FOOT: z.enum(['include', 'exclude']).optional(),
          ANY: z.enum(['include', 'exclude']).optional(),
        })
        .strict(),
    )
    .refine((holds) => Object.keys(holds).length <= MAX_HOLD_FILTER_ENTRIES, {
      message: 'Too many hold filters',
    })
    .optional(),
  hideAttempted: z.boolean().optional(),
  hideCompleted: z.boolean().optional(),
  showOnlyAttempted: z.boolean().optional(),
  showOnlyCompleted: z.boolean().optional(),
  // 1-5 matches the boardsesh_ticks_quality_range CHECK. 0 is accepted and
  // means "no minimum" (mapSearchInputToParams collapses it), mirroring the
  // community minRating whose default is 0 — a client sending the default
  // must not 400 the whole search.
  minUserRating: z.number().int().min(0).max(5).optional(),
  onlyRatedByMe: z.boolean().optional(),
  onlyDrafts: z.boolean().optional(),
  projectsOnly: z.boolean().optional(),
  // No default here on purpose: omitted means "no climb-type constraint"
  // (both boulders and routes match), not "boulders-only". searchClimbs (see
  // packages/backend/src/graphql/resolvers/climbs/queries.ts) now uses the
  // parsed/defaulted return of validateInput(ClimbSearchInputSchema, ...),
  // so a `.default()` here would actually apply — a boulders-only default
  // would silently narrow every caller that omits these fields, and
  // @boardsesh/climb-filters' toClimbSearchInput relies on the both-off case
  // staying undefined (hardened by #2636, which closed #3975's original
  // symptom by always sending explicit values for the "All" case). If a
  // future change wants a real default, audit every caller of
  // toClimbSearchInput first, not just the web client.
  boulders: z.boolean().optional(),
  routes: z.boolean().optional(),
  // Four Quantum layers × 92 diodes. This search request carries only the
  // server-derived occupied placements, never raw controller roster identities.
  occupiedPlacementIds: z.array(z.number().int().min(0)).max(368).optional(),
  maxOccupiedOverlap: z.union([z.literal(0), z.literal(1)]).optional(),
  zoneBox: z
    .object({
      edgeLeft: z.number().int(),
      edgeRight: z.number().int(),
      edgeBottom: z.number().int(),
      edgeTop: z.number().int(),
    })
    .refine((box) => box.edgeRight > box.edgeLeft && box.edgeTop > box.edgeBottom, {
      message: 'zoneBox edges must form a non-empty box (right > left, top > bottom)',
    })
    .optional(),
  zoneMode: z.enum(['allHolds', 'anyHold']).optional(),
});

// Only the freely-toggleable characteristics (no_kickboard, campus) are settable
// through the SaveClimbInput/UpdateClimbInput `characteristics` field — no_match
// is derived from `description` (see the resolver), and MoonBoard method tokens
// are creation-time-only via SaveMoonBoardClimbInput.
// .nullable(): the GraphQL field is a nullable list, and clients (mobile's
// buildToggleableCharacteristics) send explicit `null` when both toggles are off —
// `.optional()` alone rejects that literal null and 400s every ordinary
// save/update, not just ones touching these two characteristics.
// .refine: a client can only mean one thing by repeating a token twice, and
// `withCharacteristic` is idempotent either way, but rejecting the duplicate
// up front is cheaper to reason about than silently tolerating malformed input.
const ToggleableCharacteristicsSchema = z
  .array(z.enum([...TOGGLEABLE_CLIMB_CHARACTERISTICS]))
  .max(TOGGLEABLE_CLIMB_CHARACTERISTICS.length)
  .refine((tokens) => new Set(tokens).size === tokens.length, {
    message: 'characteristics must not contain duplicate tokens',
  })
  .optional()
  .nullable();

export const SaveClimbInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  isDraft: z.boolean(),
  frames: z.string().min(1).max(10000),
  framesCount: z.number().int().min(1).optional(),
  framesPace: z.number().int().min(0).optional(),
  angle: z.number().int().min(0).max(90),
  characteristics: ToggleableCharacteristicsSchema,
});

export const UpdateClimbInputSchema = z.object({
  uuid: z.string().min(1).max(100),
  boardType: BoardNameSchema,
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  frames: z.string().min(1).max(10000).optional(),
  angle: z.number().int().min(0).max(90).optional(),
  isDraft: z.boolean().optional(),
  framesCount: z.number().int().min(1).optional(),
  framesPace: z.number().int().min(0).optional(),
  characteristics: ToggleableCharacteristicsSchema,
});

export const MoonBoardHoldsInputSchema = z.object({
  start: z.array(z.string()).default([]),
  hand: z.array(z.string()).default([]),
  finish: z.array(z.string()).default([]),
});

export const SaveMoonBoardClimbInputSchema = z.object({
  boardType: z.literal('moonboard'),
  layoutId: z.number().int().positive('Layout ID must be positive'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().default(''),
  holds: MoonBoardHoldsInputSchema,
  angle: z.number().int().min(0).max(90),
  isDraft: z.boolean().optional(),
  userGrade: z.string().max(20).optional(),
  isBenchmark: z.boolean().optional(),
  // MoonBoard problem "method" as a characteristic token (mutually exclusive).
  // Omitted = the "feet follow hands" default. Source of truth for the token set:
  // CLIMB_CHARACTERISTICS in @boardsesh/shared-schema.
  method: z
    .enum([
      CLIMB_CHARACTERISTICS.METHOD_FOOTLESS,
      CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD,
      CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD,
    ])
    .optional(),
  setter: z.string().max(100).optional(),
});

export const CheckMoonBoardClimbDuplicatesInputSchema = z.object({
  layoutId: z.number().int().positive('Layout ID must be positive'),
  angle: z.number().int().min(0).max(90),
  climbs: z
    .array(
      z.object({
        clientKey: z.string().min(1).max(200),
        holds: MoonBoardHoldsInputSchema,
      }),
    )
    .min(1)
    .max(100),
});

export const SetterStatsInputSchema = z.object({
  boardName: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
  sizeId: z.number().int().positive('Size ID must be positive'),
  setIds: z.string().min(1, 'Set IDs cannot be empty'),
  // Live board angle; Aurora supports negative tilt. Mobile's setter filter
  // sends the live angle here.
  angle: z.number().int().min(-90).max(90),
  search: z.string().max(200).optional(),
});

export const SimilarClimbsInputSchema = z
  .object({
    boardType: BoardNameSchema,
    layoutId: z.number().int().positive('Layout ID must be positive'),
    threshold: z.number().min(0).max(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    // ExternalUUIDSchema keeps these aligned with the rest of the codebase
    // (favorites, playlists, etc.) and length-bounds them so a malformed
    // string can't reach the underlying SQL.
    excludeClimbUuid: ExternalUUIDSchema.optional(),
    // Aurora boards support negative tilt (e.g. -5°); angle is only an optional
    // stats-join key here, so a non-matching value nulls the join rather than erroring.
    angle: z.number().int().min(-90).max(90).optional(),
    climbUuid: ExternalUUIDSchema.optional(),
    frames: z.string().min(1).max(10000).optional(),
  })
  .refine((input) => Boolean(input.climbUuid) !== Boolean(input.frames), {
    message: 'Provide exactly one of climbUuid or frames',
  });
