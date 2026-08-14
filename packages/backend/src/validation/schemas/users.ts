import { z } from 'zod';
import { BoardNameSchema } from './primitives';

/**
 * Update profile input validation schema.
 *
 * Every field is nullable as well as optional: omitting it means "leave this
 * one alone", passing null means "clear it". That is the contract the settings
 * form has always used (it sends `trim() || null` for the text fields), so
 * dropping the nullability would turn "remove my Instagram link" into a
 * validation error instead of a save.
 */
export const UpdateProfileInputSchema = z.object({
  displayName: z.string().min(1).max(100).optional().nullable(),
  avatarUrl: z.string().url().max(500).optional().nullable(),
  instagramUrl: z.string().url().max(500).optional().nullable(),
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
