import { z } from 'zod';
import { MAX_SEARCH_PAGE } from '@boardsesh/db/queries';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

// Cap holdsFilter entries: each ANY entry becomes a LIKE scan over board_climbs.frames
// (no trigram index there), so an unbounded record is a cheap amplification vector on
// an anonymous endpoint. 300 is far above any board layout's usable hold count, so it
// never rejects a real per-hold selection.
const MAX_HOLD_FILTER_ENTRIES = 300;

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
  angle: z.number().min(0).max(90),
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
  uuid: z.string().uuid('Invalid UUID format'),
  climb: ClimbInputSchema,
  addedBy: z.string().max(100).nullish(),
  addedByUser: QueueItemUserSchema.nullish(),
  tickedBy: z.array(z.string()).max(100).nullish(),
  suggested: z.boolean().nullish(),
});

/**
 * Queue array validation schema (with size limit)
 */
export const QueueArraySchema = z.array(ClimbQueueItemSchema).max(500, 'Queue too large');

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
  onlyDrafts: z.boolean().optional(),
  projectsOnly: z.boolean().optional(),
  // Default to boulders-only so non-web GraphQL callers (mobile, scripts)
  // get the same shape as the web UI when the field is omitted. Web sends
  // explicit values from URL state, so its behaviour is unchanged.
  boulders: z.boolean().optional().default(true),
  routes: z.boolean().optional().default(false),
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
  angle: z.number().int().min(0).max(90),
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
    angle: z.number().int().min(0).max(90).optional(),
    climbUuid: ExternalUUIDSchema.optional(),
    frames: z.string().min(1).max(10000).optional(),
  })
  .refine((input) => Boolean(input.climbUuid) !== Boolean(input.frames), {
    message: 'Provide exactly one of climbUuid or frames',
  });
