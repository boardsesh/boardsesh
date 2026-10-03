import { z } from 'zod';
import { BoardNameSchema } from './primitives';

/**
 * Follow input validation schema
 */
export const FollowInputSchema = z.object({
  userId: z.string().min(1, 'User ID cannot be empty'),
});

/**
 * Follow list input validation schema
 */
export const FollowListInputSchema = z.object({
  userId: z.string().min(1, 'User ID cannot be empty'),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Search users input validation schema
 */
export const SearchUsersInputSchema = z.object({
  query: z.string().min(2, 'Search query must be at least 2 characters').max(100),
  boardType: BoardNameSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Follow setter input validation schema
 */
export const FollowSetterInputSchema = z.object({
  setterUsername: z.string().min(1, 'Setter username cannot be empty').max(100),
});

/**
 * Follow playlist input validation schema
 */
export const FollowPlaylistInputSchema = z.object({
  playlistUuid: z.string().min(1, 'Playlist UUID cannot be empty'),
});

/**
 * Setter profile input validation schema
 */
export const SetterProfileInputSchema = z.object({
  username: z.string().min(1, 'Username cannot be empty').max(100),
});

/**
 * Setter climbs input validation schema
 */
export const SetterClimbsInputSchema = z.object({
  username: z.string().min(1, 'Username cannot be empty').max(100),
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  sortBy: z.enum(['popular', 'new']).optional().default('popular'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Setter climbs full input validation schema (with full Climb data for thumbnails)
 */
export const SetterClimbsFullInputSchema = z.object({
  username: z.string().min(1, 'Username cannot be empty').max(100),
  boardType: BoardNameSchema.optional(),
  layoutId: z.number().int().positive().optional(),
  sizeId: z.number().int().positive().optional(),
  setIds: z.string().optional(),
  angle: z.number().int().optional(),
  sortBy: z.enum(['popular', 'new']).optional().default('popular'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * User climbs input validation schema
 */
export const UserClimbsInputSchema = z.object({
  userId: z.string().min(1).max(100),
  sortBy: z.enum(['popular', 'new']).optional().default('popular'),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Following ascents feed input validation schema
 */
export const FollowingAscentsFeedInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Following climb ascents input validation schema
 */
export const FollowingClimbAscentsInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuid: z.string().min(1, 'Climb UUID cannot be empty').max(100),
});

/**
 * Per-climb logs input validation schema.
 *
 * `angle` is any integer on purpose: an angle no board has is an empty page,
 * not a validation error.
 */
export const ClimbLogsInputSchema = z.object({
  boardType: BoardNameSchema,
  climbUuid: z.string().min(1, 'Climb UUID cannot be empty').max(100),
  angle: z.number().int().optional().nullable(),
  withNotes: z.boolean().optional().nullable(),
  sendsOnly: z.boolean().optional().nullable(),
  excludeFollowed: z.boolean().optional().nullable(),
  latestPerClimber: z.boolean().optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().max(512).optional().nullable(),
});

/**
 * New climb feed schemas
 */
export const NewClimbSubscriptionInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
});

export const NewClimbFeedInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('Layout ID must be positive'),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});
