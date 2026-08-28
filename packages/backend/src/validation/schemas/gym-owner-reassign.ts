import { z } from 'zod';
import { UUIDSchema } from './primitives';

// User ids are opaque text in this schema (NextAuth cuid/uuid, plus fixture ids
// in tests), so they are length-bounded strings rather than UUIDs.
const UserIdSchema = z.string().trim().min(1).max(255);

export const GymOwnershipLookupInputSchema = z.object({
  gymQuery: z.string().trim().min(1).max(200),
  newOwnerQuery: z.string().trim().min(1).max(255),
});

export const ReassignGymOwnerInputSchema = z.object({
  gymUuid: UUIDSchema,
  expectedCurrentOwnerId: UserIdSchema,
  newOwnerId: UserIdSchema,
  reason: z.string().trim().min(10).max(500),
});
