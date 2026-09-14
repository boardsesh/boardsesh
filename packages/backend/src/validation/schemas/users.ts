import { z } from 'zod';
import { AuroraBoardNameSchema } from './primitives';

/**
 * Update profile input validation schema
 */
export const UpdateProfileInputSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
  avatarUrl: z.string().url().max(500).optional(),
});

/**
 * Save Aurora credential input validation schema.
 *
 * `AuroraBoardNameSchema`, not the app-wide `BoardNameSchema`: this input is a
 * username and a password on their way to an Aurora host, and a non-Aurora board
 * type resolves that host to `https://undefined.com`. See the schema's own note.
 */
export const SaveAuroraCredentialInputSchema = z.object({
  boardType: AuroraBoardNameSchema,
  username: z.string().min(1, 'Username cannot be empty').max(100),
  password: z.string().min(1, 'Password cannot be empty').max(100),
});

/**
 * Delete account input validation schema
 */
export const DeleteAccountInputSchema = z.object({
  removeSetterName: z.boolean(),
});
