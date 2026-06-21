import { z } from 'zod';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import {
  UUIDSchema,
  BoardNameSchema,
  LatitudeSchema,
  LongitudeSchema,
  SlugSchema,
  BoardSerialSchema,
  normalizeSerial,
} from './primitives';

const OptionalBoardSerialInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}, BoardSerialSchema.optional());

const NullableBoardSerialInputSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}, BoardSerialSchema.optional().nullable());

/**
 * Create board input validation schema
 */
export const CreateBoardInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
  sizeId: z.number().int().positive('Size ID must be positive'),
  setIds: z.string().min(1, 'Set IDs cannot be empty'),
  name: z.string().min(1, 'Board name cannot be empty').max(100, 'Board name too long'),
  description: z.string().max(500, 'Description too long').optional(),
  locationName: z.string().max(200, 'Location name too long').optional(),
  latitude: LatitudeSchema.optional(),
  longitude: LongitudeSchema.optional(),
  isPublic: z.boolean().optional(),
  isUnlisted: z.boolean().optional(),
  hideLocation: z.boolean().optional(),
  isOwned: z.boolean().optional(),
  gymUuid: UUIDSchema.optional(),
  angle: z.number().int().min(0).max(70).optional(),
  isAngleAdjustable: z.boolean().optional(),
  serialNumber: OptionalBoardSerialInputSchema,
});

/**
 * Update board input validation schema
 */
export const UpdateBoardInputSchema = z.object({
  boardUuid: UUIDSchema,
  name: z.string().min(1).max(100).optional(),
  slug: SlugSchema.optional(),
  description: z.string().max(500).optional().nullable(),
  locationName: z.string().max(200).optional().nullable(),
  latitude: LatitudeSchema.optional().nullable(),
  longitude: LongitudeSchema.optional().nullable(),
  isPublic: z.boolean().optional(),
  isUnlisted: z.boolean().optional(),
  hideLocation: z.boolean().optional(),
  isOwned: z.boolean().optional(),
  angle: z.number().int().min(0).max(70).optional(),
  isAngleAdjustable: z.boolean().optional(),
  layoutId: z.number().int().positive('Layout ID must be positive').optional(),
  sizeId: z.number().int().positive('Size ID must be positive').optional(),
  setIds: z.string().min(1, 'Set IDs cannot be empty').optional(),
  serialNumber: NullableBoardSerialInputSchema,
});

/**
 * Board leaderboard input validation schema
 */
export const BoardLeaderboardInputSchema = z.object({
  boardUuid: UUIDSchema,
  period: z.enum(['week', 'month', 'year', 'all']).optional().default('all'),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * My boards input validation schema
 */
export const MyBoardsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Follow board input validation schema
 */
export const FollowBoardInputSchema = z.object({
  boardUuid: UUIDSchema,
});

/**
 * Search boards input validation schema
 */
export const SearchBoardsInputSchema = z.object({
  query: z.string().max(200).optional(),
  boardType: BoardNameSchema.optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(0.1).max(500).optional().default(50),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Popular board configs input validation schema
 */
export const PopularBoardConfigsInputSchema = z.object({
  boardType: BoardNameSchema.optional(),
  limit: z.number().int().min(1).max(100).optional().default(12),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Schema for `boardsBySerialNumbers` and `myBoardSerialConfigs` queries.
 * Caps the array length and per-element size so an attacker can't push a
 * massive IN-list into the resolver.
 */
export const SerialNumberLookupSchema = z.object({
  // Normalized so a lookup matches the canonical serials stored by the resolve
  // and record paths (see normalizeSerial).
  serialNumbers: z.array(z.string().trim().min(1).max(64).transform(normalizeSerial)).max(20),
});

/**
 * Record-board-serial input validation schema. Mirrors the deleted REST route
 * (`packages/web/app/api/internal/board-serials/route.ts`) and adds `apiLevel`,
 * the protocol level parsed from the BLE device name's `@N` suffix. Only Aurora
 * boards advertise a serial in this format, so `boardName` is the Aurora enum.
 */
export const RecordBoardSerialInputSchema = z.object({
  serialNumber: z.string().trim().min(1).max(64).transform(normalizeSerial),
  boardName: z.enum(AURORA_BOARDS),
  layoutId: z.number().int().nonnegative(),
  sizeId: z.number().int().nonnegative(),
  // Comma-separated positive integers only — no whitespace, no empties.
  setIds: z
    .string()
    .max(256)
    .regex(/^\d+(,\d+)*$/, 'setIds must be a comma-separated list of integers'),
  apiLevel: z.number().int().nonnegative().optional(),
  // Saved-board uuids are RFC 4122 UUIDs; validate strictly like every other
  // boardUuid in this file so a malformed value is rejected up front rather than
  // reaching the ownership query as a garbage string that can't match anyway.
  boardUuid: UUIDSchema.optional(),
});
