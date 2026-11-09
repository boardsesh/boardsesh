import { z } from 'zod';
import { AuroraBoardNameSchema } from './primitives';

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
 * The board a "Sync now" names. Every Aurora-family board, Kilter included: each
 * has a sync family (`aurora-user-sync`, `kilter-user-sync`).
 */
export const ProviderSyncBoardTypeSchema = AuroraBoardNameSchema;

/**
 * Delete account input validation schema
 */
export const DeleteAccountInputSchema = z.object({
  removeSetterName: z.boolean(),
});
