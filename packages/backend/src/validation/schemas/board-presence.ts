import { z } from 'zod';
import { MAX_ACTIVE_BOARD_LAYERS, MAX_DIODES_PER_LAYER } from '@boardsesh/board-layers';
import type { BoardLayersSnapshot, BoardPresenceClimb, BoardPresenceEvent } from '@boardsesh/shared-schema';
import { ClimbInputSchema } from './climbs';
import { BoardNameSchema, ClimbUuidSchema, ExternalUUIDSchema, NumericCsvSchema } from './primitives';

export const BoardPresenceConfigInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('layoutId must be a positive integer'),
  sizeId: z.number().int().positive('sizeId must be a positive integer'),
  setIds: NumericCsvSchema,
});

/**
 * The board type parsed from the connected controller's BLE device name
 * (`Tension Board#12345@3`). Scopes every serial lookup to the hardware in
 * front of the climber, because Aurora runs a separate serial sequence per
 * board app. Nullish for clients shipped before the serial-per-board-type fix,
 * which keep the old type-blind resolution.
 */
export const AdvertisedBoardTypeSchema = BoardNameSchema.nullish();

const GRAPHQL_INT_MIN = -2_147_483_648;
const GRAPHQL_INT_MAX = 2_147_483_647;

/** GraphQL's `Int` scalar is signed 32-bit, unlike an unrestricted JS number. */
export const GraphQLIntSchema = z.number().int().min(GRAPHQL_INT_MIN).max(GRAPHQL_INT_MAX);
const PositiveGraphQLIntSchema = GraphQLIntSchema.positive();

// Live board angle; Aurora supports negative tilt.
export const BoardPresenceAngleSchema = GraphQLIntSchema.min(-90).max(90).nullable().optional();

export const ReportBoardClimbInputSchema = z.object({
  uuid: z.string().min(1, 'Queue item UUID cannot be empty').max(100, 'Queue item UUID too long'),
  climb: ClimbInputSchema.extend({
    uuid: ClimbUuidSchema,
  }),
  addedBy: z.string().max(100).nullish(),
  addedByUser: z
    .object({
      id: z.string().max(100),
      username: z.string().max(100),
      avatarUrl: z.string().max(500).nullish(),
    })
    .nullish(),
  tickedBy: z.array(z.string().max(100)).max(100).nullish(),
  suggested: z.boolean().nullish(),
});

export const ReportBoardLayerInputSchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Board layer colour must be a 24-bit hex colour')
    .transform((color) => color.toUpperCase()),
  remainingSeconds: z.number().int().min(0).max(65_535),
  climbUuid: ExternalUUIDSchema.nullish(),
  angle: BoardPresenceAngleSchema,
  geometryKnown: z.boolean(),
});

export const ReportBoardLayersInputSchema = z.array(ReportBoardLayerInputSchema).max(MAX_ACTIVE_BOARD_LAYERS);

const OptionalNullableTextSchema = z.string().nullable().optional();

/** Runtime boundary for board-history entries read back from Redis. */
export const BoardPresenceClimbRedisSchema: z.ZodType<BoardPresenceClimb> = z.object({
  climbUuid: z.string().min(1).max(100),
  queueItemUuid: OptionalNullableTextSchema,
  name: OptionalNullableTextSchema,
  grade: OptionalNullableTextSchema,
  gradeColor: OptionalNullableTextSchema,
  frames: OptionalNullableTextSchema,
  angle: BoardPresenceAngleSchema,
  setter: OptionalNullableTextSchema,
  sentByDisplayName: OptionalNullableTextSchema,
  sentByAvatarUrl: OptionalNullableTextSchema,
  sentByUserId: OptionalNullableTextSchema,
  sentAt: z.iso.datetime({ offset: true }),
  seq: PositiveGraphQLIntSchema,
});

const BoardLayerPresenceRedisSchema = ReportBoardLayerInputSchema.extend({
  placementIds: z.array(PositiveGraphQLIntSchema).max(MAX_DIODES_PER_LAYER),
});

/** Runtime boundary for Quantum layer snapshots read back from Redis. */
export const BoardLayersSnapshotRedisSchema: z.ZodType<BoardLayersSnapshot> = z.object({
  boardId: PositiveGraphQLIntSchema,
  layers: z.array(BoardLayerPresenceRedisSchema).max(MAX_ACTIVE_BOARD_LAYERS),
  observedAt: z.iso.datetime({ offset: true }),
  stale: z.boolean(),
  seq: PositiveGraphQLIntSchema,
});

const BoardPresenceHardestSendRedisSchema = z.object({
  climbUuid: z.string().min(1).max(100),
  name: OptionalNullableTextSchema,
  grade: z.string(),
  sentByUserId: z.string(),
  sentByDisplayName: OptionalNullableTextSchema,
  sentByAvatarUrl: OptionalNullableTextSchema,
  sentAt: z.iso.datetime({ offset: true }),
});

const BoardPresenceStatsRedisSchema = z.object({
  climbsSentCount: GraphQLIntSchema.nonnegative(),
  distinctClimbersCount: GraphQLIntSchema.nonnegative(),
  hardestGrade: OptionalNullableTextSchema,
  hardestSend: BoardPresenceHardestSendRedisSchema.nullable().optional(),
  topGrade: OptionalNullableTextSchema,
  lastSentAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

const BoardConnectionHolderRedisSchema = z.object({
  userId: OptionalNullableTextSchema,
  displayName: OptionalNullableTextSchema,
  avatarUrl: OptionalNullableTextSchema,
  lastSentAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

/** Runtime boundary for cross-instance board-presence events received from Redis. */
export const BoardPresenceEventRedisSchema: z.ZodType<BoardPresenceEvent> = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('BoardClimbSet'), climb: BoardPresenceClimbRedisSchema }),
  z.object({
    __typename: z.literal('BoardClimbCleared'),
    clearedAt: z.iso.datetime({ offset: true }),
    seq: PositiveGraphQLIntSchema,
  }),
  z.object({
    __typename: z.literal('BoardStatsUpdated'),
    stats: BoardPresenceStatsRedisSchema,
    seq: PositiveGraphQLIntSchema,
  }),
  z.object({
    __typename: z.literal('BoardConnectionChanged'),
    holder: BoardConnectionHolderRedisSchema.nullable(),
    seq: PositiveGraphQLIntSchema,
  }),
  z.object({ __typename: z.literal('BoardLayersChanged'), snapshot: BoardLayersSnapshotRedisSchema }),
]);
