import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

/**
 * Climb validation schema (simplified for input)
 */
export const ClimbInputSchema = z.object({
  uuid: ExternalUUIDSchema,
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
 * BoardConfig validation schema. Matches the GraphQL `BoardConfigInput`
 * shape — denormalized onto queue items so multi-board queues can render
 * without a per-item DB lookup.
 */
export const BoardConfigInputSchema = z.object({
  boardName: z.string().min(1).max(50),
  layoutId: z.number().int().positive(),
  sizeId: z.number().int().positive(),
  setIds: z.array(z.number().int().positive()).max(20),
  angle: z.number().int().min(0).max(90),
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
  boardConfig: BoardConfigInputSchema.nullish(),
  boardId: z.string().max(100).nullish(),
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
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100, 'Page size cannot exceed 100').optional(),
  gradeAccuracy: z.string().optional(),
  minGrade: z.number().int().optional(),
  maxGrade: z.number().int().optional(),
  minAscents: z.number().int().min(0).optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  name: z.string().max(200).optional(),
  setter: z.array(z.string().max(100)).optional(),
  setterId: z.number().int().optional(),
  onlyBenchmarks: z.boolean().optional(),
  onlyTallClimbs: z.boolean().optional(),
  holdsFilter: z.record(z.string(), z.enum(['OFF', 'STARTING', 'FINISH', 'HAND', 'FOOT', 'ANY', 'NOT'])).optional(),
  hideAttempted: z.boolean().optional(),
  hideCompleted: z.boolean().optional(),
  showOnlyAttempted: z.boolean().optional(),
  showOnlyCompleted: z.boolean().optional(),
  onlyDrafts: z.boolean().optional(),
  projectsOnly: z.boolean().optional(),
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
