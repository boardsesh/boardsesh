import { z } from 'zod';
import { UUIDSchema } from './primitives';

export const LocationSyncEntityTypeSchema = z.enum(['GYM', 'BOARD']);

export const FrozenLocationSyncEntitiesInputSchema = z.object({
  entityType: LocationSyncEntityTypeSchema,
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export const ClearLocationSyncFreezeInputSchema = z.object({
  entityType: LocationSyncEntityTypeSchema,
  entityUuid: UUIDSchema,
  expectedSyncFrozenAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(10).max(500),
});
