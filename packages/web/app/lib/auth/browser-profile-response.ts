import { z } from 'zod';
import { browserBackendLeaseOwnerSchema } from '@boardsesh/auth-protocol/browser-backend-lease';
import type { UserProfile } from '@/app/profile/[user_id]/utils/profile-constants';

export const BROWSER_PROFILE_RESPONSE_MAX_BYTES = 65_536;

const profileSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().optional(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    profile: z
      .object({
        displayName: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        instagramUrl: z.string().nullable(),
      })
      .strict()
      .nullable(),
    credentials: z.array(z.object({ boardType: z.string(), auroraUsername: z.string() }).strict()).optional(),
    followerCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    followingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    isFollowedByMe: z.boolean(),
    isPrivate: z.boolean().optional(),
    canViewActivity: z.boolean().optional(),
  })
  .strict()
  .transform((profile): UserProfile => ({ ...profile, email: profile.email }));

/** The owner is an admission label, never a credential or client receipt. */
export const browserProfileResponseSchema = z
  .object({
    browserProfileVersion: z.literal(1),
    owner: browserBackendLeaseOwnerSchema.nullable(),
    profile: profileSchema,
  })
  .strict();

export class ProfileNotFoundError extends Error {
  readonly code = 'PROFILE_NOT_FOUND';
  constructor() {
    super('Profile not found');
  }
}

export class BrowserProfileAuthorityError extends Error {
  constructor(readonly code: 'superseded' | 'unavailable') {
    super('Profile authority is unavailable');
  }
}
