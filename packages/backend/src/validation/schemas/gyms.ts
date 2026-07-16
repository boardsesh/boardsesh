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
 * Brand colour: exactly #RRGGBB (six hex digits). The kiosk and embed surfaces
 * read these straight into CSS custom properties, so anything looser is rejected.
 */
export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be #RRGGBB');

/**
 * Gym logo URL: either a backend-relative static path we serve ourselves
 * (exactly `/static/gym-logos/<uuid>.<ext>[?v=...]`, as written by
 * POST /api/gym-logos — full-pattern matched so no traversal or other-path
 * strings slip through) or a well-formed https URL, capped at 500 chars.
 * Rejecting other schemes (javascript:, data:, http:) matters because the logo
 * renders as an `<img src>` on the kiosk/embed surfaces.
 */
const STATIC_GYM_LOGO_PATH_REGEX = /^\/static\/gym-logos\/[0-9a-f-]{36}\.(jpg|jpeg|png|gif|webp)(\?v=[\w-]+)?$/i;

function isValidHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export const GymLogoUrlSchema = z
  .string()
  .max(500)
  .refine(
    (value) => STATIC_GYM_LOGO_PATH_REGEX.test(value) || isValidHttpsUrl(value),
    'Logo URL must be an https URL or a Boardsesh static gym-logo path',
  );

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
  logoUrl: GymLogoUrlSchema.optional().nullable(),
  brandPrimaryColor: HexColorSchema.optional().nullable(),
  brandAccentColor: HexColorSchema.optional().nullable(),
  brandBackgroundColor: HexColorSchema.optional().nullable(),
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
 * Find similar gyms input validation schema. Powers the "is this gym already on
 * Boardsesh?" dedup suggestions surfaced during gym creation. Coordinates are
 * optional — with them the resolver adds proximity tiers, without them it falls
 * back to name-only matching.
 */
export const FindSimilarGymsInputSchema = z.object({
  name: z.string().min(1, 'Gym name cannot be empty').max(100, 'Gym name too long'),
  latitude: LatitudeSchema.optional(),
  longitude: LongitudeSchema.optional(),
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

/**
 * Gym insights (owner activity dashboard) input validation schema. `period`
 * chooses the window length; the resolver derives the day count and the equally
 * long prior comparison window from it.
 */
export const GymStatsInputSchema = z.object({
  gymUuid: UUIDSchema,
  period: z.enum(['week', 'month']).optional().default('week'),
});

/**
 * Duplicate-gym cluster list input validation schema (admin)
 */
export const DuplicateGymClustersInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Orphan-gym audit list input validation schema (admin)
 */
export const OrphanGymsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

/**
 * Merge gyms input validation schema (admin). Fold 1–50 duplicates into one
 * canonical survivor. The resolver additionally checks every uuid is a live,
 * un-merged gym and that the canonical is not among the duplicates.
 */
export const MergeGymsInputSchema = z.object({
  canonicalGymUuid: UUIDSchema,
  duplicateGymUuids: z.array(UUIDSchema).min(1, 'Pick at least one duplicate').max(50),
  // Explicit acknowledgement required to keep a SYSTEM listing as the survivor
  // over a user-owned or claim-approved duplicate (an inverted pre-selection).
  allowSystemCanonicalOverride: z.boolean().optional().default(false),
});

/**
 * Dismiss gym cluster input validation schema (admin). The full member set is
 * needed to compute the stable cluster signature the dismissal is keyed on.
 */
export const DismissGymClusterInputSchema = z.object({
  gymUuids: z.array(UUIDSchema).min(2, 'A cluster has at least two members').max(50),
  canonicalGymUuid: UUIDSchema,
});
