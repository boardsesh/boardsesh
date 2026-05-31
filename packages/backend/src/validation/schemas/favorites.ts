import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

/**
 * Toggle favorite input validation schema
 */
export const ToggleFavoriteInputSchema = z.object({
  boardName: BoardNameSchema,
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int(),
});

/**
 * Add favorite input validation schema (idempotent, sync-safe).
 * Same field shape as ToggleFavoriteInput.
 */
export const AddFavoriteInputSchema = z.object({
  boardName: BoardNameSchema,
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int(),
});

/**
 * Remove favorite input validation schema (idempotent, sync-safe).
 * Same field shape as ToggleFavoriteInput.
 */
export const RemoveFavoriteInputSchema = z.object({
  boardName: BoardNameSchema,
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int(),
});

/**
 * Favorites query climbUuids validation schema (matches playlistsForClimbs limit)
 */
export const FavoritesQueryClimbUuidsSchema = z.array(ExternalUUIDSchema).min(1).max(500);

/**
 * Get user favorite climbs input validation schema
 */
export const GetUserFavoriteClimbsInputSchema = z.object({
  boardName: BoardNameSchema,
  layoutId: z.number().int().positive(),
  sizeId: z.number().int().positive(),
  setIds: z.string().min(1),
  angle: z.number().int(),
  page: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
