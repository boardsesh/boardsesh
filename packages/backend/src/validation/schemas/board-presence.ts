import { z } from 'zod';
import { ClimbInputSchema } from './climbs';
import { BoardNameSchema, ClimbUuidSchema } from './primitives';

export const BoardPresenceConfigInputSchema = z.object({
  boardType: BoardNameSchema,
  layoutId: z.number().int().positive('layoutId must be a positive integer'),
  sizeId: z.number().int().positive('sizeId must be a positive integer'),
  setIds: z
    .string()
    .min(1, 'setIds is required')
    .max(256, 'setIds too long')
    .regex(/^\d+(,\d+)*$/, 'setIds must be a comma-separated list of integers'),
});

export const BoardPresenceAngleSchema = z.number().int().min(0).max(90).nullable().optional();

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
