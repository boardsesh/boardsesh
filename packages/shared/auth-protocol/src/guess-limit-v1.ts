import { z } from 'zod';

/**
 * The per-account password guess limit for the web's legacy sign-in (#7656).
 * The web compares passwords itself but never writes the counter, which sits
 * behind the identity-table fence: it asks the backend to reserve a guess
 * before the compare and to give it back after a right password, and to clear
 * an address after a completed reset. Signed with `CURRENT_STORE_AUTH_RPC_SECRET`.
 * The backend serves it only while `AUTH_ACCOUNT_GUESS_LIMIT_MODE` is not `off`.
 */
export const GUESS_LIMIT_VERSION = 1;
export const GUESS_LIMIT_PREFIX = '/api/internal/auth/guess-limit/v1';
export const GUESS_LIMIT_PATHS = {
  reserve: `${GUESS_LIMIT_PREFIX}/reserve`,
  'give-back': `${GUESS_LIMIT_PREFIX}/give-back`,
  clear: `${GUESS_LIMIT_PREFIX}/clear`,
} as const;
export const GUESS_LIMIT_REQUEST_BYTES = 4_096;
/** The web gives each call this long in total, then signs in uncounted. */
export const GUESS_LIMIT_WEB_TIMEOUT_MS = 400;

const metadata = {
  version: z.literal(GUESS_LIMIT_VERSION),
  requestId: z.uuid(),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const email = z.string().min(1).max(320);
const userId = z.string().min(1).max(256);
const windowStart = z.iso.datetime();

/** What a reserve counted, handed back unchanged on give-back. */
export const guessReservationSchema = z
  .object({
    /** Single use: a give-back of the same id uncounts nothing more. */
    id: z.uuid(),
    bucket: z.enum(['email', 'account']),
    /** Set for the `account` bucket: the account the device token was verified for. */
    userId: userId.optional(),
    windows: z
      .array(z.object({ kind: z.enum(['hour', 'day']), start: windowStart }).strict())
      .min(1)
      .max(2),
  })
  .strict();
export type GuessReservation = z.infer<typeof guessReservationSchema>;

export const guessReserveCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('reserve'),
    email,
    /** The browser's device-token cookie, as received. */
    deviceToken: z.string().min(1).max(256).optional(),
    /** The account the web's lookup found for the email; a token counts only for it. */
    candidateUserId: userId.optional(),
  })
  .strict();
export type GuessReserveCommand = z.infer<typeof guessReserveCommandSchema>;

export const guessGiveBackCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('give-back'),
    email,
    /** `accepted`: the password was right. `no_verdict`: the compare never finished. */
    verdict: z.enum(['accepted', 'no_verdict']),
    reservation: guessReservationSchema.optional(),
    /** The reserve said `observe` would have refused it. */
    wouldRefuse: z.boolean().optional(),
  })
  .strict();
export type GuessGiveBackCommand = z.infer<typeof guessGiveBackCommandSchema>;

export const guessClearCommandSchema = z.object({ ...metadata, operation: z.literal('clear'), email }).strict();
export type GuessClearCommand = z.infer<typeof guessClearCommandSchema>;

export const guessReserveReplySchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('proceed'),
      reservation: guessReservationSchema.optional(),
      wouldRefuse: z.boolean().optional(),
    })
    .strict(),
  z.object({ outcome: z.literal('refused'), retryAfterSeconds: z.number().int().positive() }).strict(),
]);
export type GuessReserveReply = z.infer<typeof guessReserveReplySchema>;
export const guessDoneReplySchema = z.object({ outcome: z.literal('done') }).strict();
