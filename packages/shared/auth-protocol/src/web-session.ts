import { z } from 'zod';

/**
 * The first-party web session the backend issues (#7596, owner decisions of
 * 2026-11-17). The backend owns the session row; www owns the cookie that
 * carries its token. Both sides read these numbers and shapes from here.
 */

/** A session row lives this long after it was issued or last rolled: 30 days. */
export const WEB_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * A row is rolled only once fewer than this many seconds remain: 29 days. So
 * an active session is written at most once a day, and a roll never writes the
 * cookie.
 */
export const WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS = 29 * 24 * 60 * 60;

/**
 * The backend switch for issuing, signing out and rolling these sessions over
 * the private www-to-backend channel. Unset, empty or `legacy` is off, and
 * every command answers 404.
 */
export const WEB_SESSION_MODE_ENV = 'CURRENT_STORE_WEB_SESSION_MODE';
export type WebSessionMode = 'legacy' | 'backend-staging';
export function webSessionMode(environment: Readonly<Record<string, string | undefined>> = {}): WebSessionMode {
  const mode = environment[WEB_SESSION_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('Invalid web session mode');
}

export const WEB_SESSION_PROTOCOL_VERSION = 1;
export const WEB_SESSION_PATH_PREFIX = '/api/internal/auth/current-store/web-session/v1';
export const WEB_SESSION_COMMAND_PATHS = {
  signout: `${WEB_SESSION_PATH_PREFIX}/signout`,
  roll: `${WEB_SESSION_PATH_PREFIX}/roll`,
} as const;

/** The opaque token as www read it from the session cookie, after the cookie signature checked out. */
const sessionToken = z.string().min(1).max(4096);
const identityId = z.string().min(1).max(1024);

/**
 * The longest joined NextAuth cookie a command accepts. It must fit the
 * 16,384-byte private body budget (`AUTH_COMMAND_REQUEST_BYTES`) with the rest
 * of the command. NextAuth splits its cookie into chunks of at most 4,096
 * bytes, name included, and today's is one chunk of about 1.5 KB, so three
 * full chunks still fit. A longer value is refused by the schema (400) instead
 * of by the body reader.
 */
export const LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH = 12_288;

/**
 * The session a login request arrived with, which that login revokes: the raw
 * NextAuth cookie (`legacy-jwe`, joined from its chunks) or the canonical
 * token. A session that no longer reads as live is ignored.
 */
export const presentedWebSessionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('legacy-jwe'),
      credential: z.string().min(1).max(LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH),
    })
    .strict(),
  z.object({ kind: z.literal('canonical-token'), token: sessionToken }).strict(),
]);

/**
 * Asks the staged password command to issue a session for the account it
 * verifies. Only that account: the web never names a user.
 */
export const webSessionRequestSchema = z.object({ presented: presentedWebSessionSchema.optional() }).strict();

/**
 * The issued session, in the `authenticated` password reply. `token` is the
 * only copy: www puts it in the signed cookie and never logs it.
 */
export const issuedWebSessionSchema = z
  .object({
    sessionId: identityId,
    token: sessionToken,
    expiresAt: z.iso.datetime(),
    generation: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();

const version = z.literal(WEB_SESSION_PROTOCOL_VERSION);
const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const issuedAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metadata = { webSessionProtocolVersion: version, requestId, issuedAt };

/** Ends the session the cookie carries, only if it is still the one the tab expected. */
export const webSessionSignOutCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('signout'),
    payload: z.object({ token: sessionToken, expectedUserId: identityId, expectedAuthSessionId: identityId }).strict(),
  })
  .strict();

/** Reads the session the cookie carries and rolls it when fewer than 29 days remain. */
export const webSessionRollCommandSchema = z
  .object({ ...metadata, operation: z.literal('roll'), payload: z.object({ token: sessionToken }).strict() })
  .strict();

const replyBase = { webSessionProtocolVersion: version, requestId };
const unavailableReply = <Operation extends keyof typeof WEB_SESSION_COMMAND_PATHS>(operation: Operation) =>
  z
    .object({
      ...replyBase,
      operation: z.literal(operation),
      outcome: z.literal('error'),
      code: z.literal('unavailable'),
    })
    .strict();

export const webSessionSignOutReplySchema = z.union([
  /** The session ended, or was not live to begin with. Clear the cookie. */
  z.object({ ...replyBase, operation: z.literal('signout'), outcome: z.literal('signed_out') }).strict(),
  /** The cookie now carries another session than the tab expected. Nothing ended; re-read the session. */
  z.object({ ...replyBase, operation: z.literal('signout'), outcome: z.literal('identity_changed') }).strict(),
  unavailableReply('signout'),
]);

export const webSessionRollReplySchema = z.union([
  z
    .object({
      ...replyBase,
      operation: z.literal('roll'),
      outcome: z.literal('active'),
      userId: identityId,
      authSessionId: identityId,
      expiresAt: z.iso.datetime(),
      rolled: z.boolean(),
    })
    .strict(),
  /** No live session: expired, revoked, cut off, or never issued. */
  z.object({ ...replyBase, operation: z.literal('roll'), outcome: z.literal('unauthenticated') }).strict(),
  unavailableReply('roll'),
]);

export type PresentedWebSession = z.infer<typeof presentedWebSessionSchema>;
export type WebSessionRequest = z.infer<typeof webSessionRequestSchema>;
export type IssuedWebSessionReply = z.infer<typeof issuedWebSessionSchema>;
export type WebSessionSignOutCommand = z.infer<typeof webSessionSignOutCommandSchema>;
export type WebSessionSignOutReply = z.infer<typeof webSessionSignOutReplySchema>;
export type WebSessionRollCommand = z.infer<typeof webSessionRollCommandSchema>;
export type WebSessionRollReply = z.infer<typeof webSessionRollReplySchema>;

/**
 * The status each reply is sent with. A 401 here always carries a body that
 * parses as the reply (`outcome: 'unauthenticated'`). The transport's own 401
 * for a wrong secret is `{ error: 'unauthorized' }`, which never parses as a
 * reply, so a caller keys on the parsed body and never on the status alone.
 */
export function webSessionReplyStatus(reply: WebSessionSignOutReply | WebSessionRollReply): number {
  if (reply.outcome === 'identity_changed') return 409;
  if (reply.outcome === 'unauthenticated') return 401;
  if (reply.outcome === 'error') return 503;
  return 200;
}
