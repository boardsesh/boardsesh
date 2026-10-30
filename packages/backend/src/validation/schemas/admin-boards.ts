import { z } from 'zod';
import { BoardNameSchema } from './primitives';

export const AdminBoardsInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  boardType: BoardNameSchema.optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});
