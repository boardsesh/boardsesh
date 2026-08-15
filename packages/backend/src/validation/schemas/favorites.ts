import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

/**
 * Favorite input validation schemas.
 *
 * Favorites are keyed by (userId, climbUuid). `boardName` and `angle` are still
 * accepted — binaries that shipped before the re-keying send them, and so do
 * favorite mutations already sitting in a device's offline outbox — but they are
 * validated-and-ignored, never written. They come off the schema entirely once
 * the store fleet has rolled past this release.
 */
export const ToggleFavoriteInputSchema = z.object({
  boardName: z.string().optional().nullable(),
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int().optional().nullable(),
});

export const AddFavoriteInputSchema = z.object({
  boardName: z.string().optional().nullable(),
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int().optional().nullable(),
});

export const RemoveFavoriteInputSchema = z.object({
  boardName: z.string().optional().nullable(),
  climbUuid: ExternalUUIDSchema,
  angle: z.number().int().optional().nullable(),
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
