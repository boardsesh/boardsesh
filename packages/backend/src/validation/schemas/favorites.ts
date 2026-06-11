import { z } from 'zod';
import { ExternalUUIDSchema, BoardNameSchema } from './primitives';

export const ToggleFavoriteInputSchema = z.object({
  climbUuid: ExternalUUIDSchema,
});

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
