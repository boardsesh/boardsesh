import { z } from 'zod';
import { BoardNameSchema } from './primitives';

/**
 * Update profile input validation schema
 */
export const LeaderboardVisibilitySchema = z.enum(['public', 'anonymous', 'off']);

export const UpdateProfileInputSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().max(500).optional(),
  // Two independent consent settings — the app's own ranked surfaces, and
  // gym-operated screens. Omitting one leaves it untouched.
  leaderboardVisibility: LeaderboardVisibilitySchema.optional(),
  gymScreenVisibility: LeaderboardVisibilitySchema.optional(),
});

/**
 * Save Aurora credential input validation schema
 */
export const SaveAuroraCredentialInputSchema = z.object({
  boardType: BoardNameSchema,
  username: z.string().min(1, 'Username cannot be empty').max(100),
  password: z.string().min(1, 'Password cannot be empty').max(100),
});

/**
 * Delete account input validation schema
 */
export const DeleteAccountInputSchema = z.object({
  removeSetterName: z.boolean(),
});
