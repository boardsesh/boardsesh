import { z } from 'zod';
import { GYM_CLAIM_MESSAGE_MAX_LENGTH } from '@boardsesh/gym-claim';
import { UUIDSchema, LatitudeSchema, LongitudeSchema, SlugSchema, BoardNameSchema } from './primitives';

/**
 * Gym member role validation schema (all roles). Used for reads/display.
 */
export const GymMemberRoleSchema = z.enum(['admin', 'editor', 'member']);

/**
 * Roles assignable via addGymMember. `editor` is intentionally excluded: write
 * access is granted only through grantGymWriteAccess (owner/admin/community-leader
 * gate), so it can't be planted through the looser member-management path.
 */
export const AddGymMemberRoleSchema = z.enum(['admin', 'member']);

/**
 * Website URL: a valid http(s) URL. Rejecting other schemes (javascript:, data:)
 * matters because the website is rendered as an href on web and is the basis for
 * domain-verified ownership claims.
 */
export const GymWebsiteSchema = z
  .string()
  .url('Invalid website URL')
  .max(500)
  .refine((value) => /^https?:\/\//i.test(value), 'Website must start with http:// or https://');

/**
 * Create gym input validation schema
 */
export const CreateGymInputSchema = z.object({
  name: z.string().min(1, 'Gym name cannot be empty').max(100, 'Gym name too long'),
  description: z.string().max(500, 'Description too long').optional(),
  address: z.string().max(300, 'Address too long').optional(),
  website: GymWebsiteSchema.optional(),
  contactEmail: z.string().email('Invalid email').max(200).optional(),
  contactPhone: z.string().max(30, 'Phone number too long').optional(),
  latitude: LatitudeSchema.optional(),
  longitude: LongitudeSchema.optional(),
  isPublic: z.boolean().optional(),
  imageUrl: z.string().url().max(500).optional(),
  boardUuid: UUIDSchema.optional(),
});

/**
 * Update gym input validation schema
 */
export const UpdateGymInputSchema = z.object({
  gymUuid: UUIDSchema,
  name: z.string().min(1).max(100).optional(),
  slug: SlugSchema.optional(),
  description: z.string().max(500).optional().nullable(),
  address: z.string().max(300).optional().nullable(),
  website: GymWebsiteSchema.optional().nullable(),
  contactEmail: z.string().email().max(200).optional().nullable(),
  contactPhone: z.string().max(30).optional().nullable(),
  latitude: LatitudeSchema.optional().nullable(),
  longitude: LongitudeSchema.optional().nullable(),
  isPublic: z.boolean().optional(),
  imageUrl: z.string().url().max(500).optional().nullable(),
});

/**
 * Grant gym write (editor) access input validation schema
 */
export const GrantGymWriteAccessInputSchema = z.object({
  gymUuid: UUIDSchema,
  userId: z.string().min(1, 'User ID cannot be empty'),
});

/**
 * Revoke gym write (editor) access input validation schema
 */
export const RevokeGymWriteAccessInputSchema = z.object({
  gymUuid: UUIDSchema,
  userId: z.string().min(1, 'User ID cannot be empty'),
});

/**
 * Request gym claim input validation schema
 */
export const RequestGymClaimInputSchema = z.object({
  gymUuid: UUIDSchema,
  claimEmail: z.string().email('Invalid email').max(200).optional(),
  message: z.string().max(GYM_CLAIM_MESSAGE_MAX_LENGTH, 'Message too long').optional(),
});

/**
 * Review gym claim input validation schema (admin)
 */
export const ReviewGymClaimInputSchema = z.object({
  claimId: z.coerce.number().int().positive(),
  decision: z.enum(['approve', 'deny']),
});

/**
 * Pending gym claims list input validation schema (admin)
 */
export const PendingGymClaimsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Add gym member input validation schema
 */
export const AddGymMemberInputSchema = z.object({
  gymUuid: UUIDSchema,
  userId: z.string().min(1, 'User ID cannot be empty'),
  role: AddGymMemberRoleSchema,
});

/**
 * Remove gym member input validation schema
 */
export const RemoveGymMemberInputSchema = z.object({
  gymUuid: UUIDSchema,
  userId: z.string().min(1, 'User ID cannot be empty'),
});

/**
 * Follow gym input validation schema
 */
export const FollowGymInputSchema = z.object({
  gymUuid: UUIDSchema,
});

/**
 * My gyms input validation schema
 */
export const MyGymsInputSchema = z.object({
  includeFollowed: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Search gyms input validation schema
 */
export const SearchGymsInputSchema = z.object({
  query: z.string().max(200).optional(),
  boardTypes: z.array(BoardNameSchema).max(10).optional(),
  layoutIds: z.array(z.number().int().nonnegative()).max(50).optional(),
  sizeIds: z.array(z.number().int().nonnegative()).max(50).optional(),
  multiBoardTypeOnly: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().min(0.1).max(500).optional().default(50),
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Gym members input validation schema
 */
export const GymMembersInputSchema = z.object({
  gymUuid: UUIDSchema,
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Link board to gym input validation schema
 */
export const LinkBoardToGymInputSchema = z.object({
  boardUuid: UUIDSchema,
  gymUuid: UUIDSchema.optional().nullable(),
});
