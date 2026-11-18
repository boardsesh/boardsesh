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
  session: `${WEB_SESSION_PATH_PREFIX}/session`,
  signout: `${WEB_SESSION_PATH_PREFIX}/signout`,
  bridge: `${WEB_SESSION_PATH_PREFIX}/bridge`,
  access: `${WEB_SESSION_PATH_PREFIX}/access`,
} as const;

/**
 * The browser access token (#7596, B3a): a 15-minute JWS the backend signs for
 * one live session. Browser JavaScript sends it as `Authorization: Bearer` and
 * as the WebSocket `authToken`; every request re-checks that its session is
 * live, so it ends with the session, not 15 minutes later.
 */
export const BROWSER_ACCESS_TOKEN_AUDIENCE = 'boardsesh-browser';
export const BROWSER_ACCESS_TOKEN_ISSUER = 'boardsesh';
/** At most this long, and never past the session row's own expiry. */
export const BROWSER_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

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

/**
 * Reads the session a cookie carries. It writes nothing: no roll, no last-seen
 * time, no bridge. A legacy cookie is answered by its own admission rules.
 */
export const webSessionReadCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('session'),
    payload: z.object({ presented: presentedWebSessionSchema }).strict(),
  })
  .strict();

const expectedIdentity = { expectedUserId: identityId, expectedAuthSessionId: identityId };

/**
 * Ends the session the cookie carries, only if it is still the one the tab
 * expected. `presented` lets a browser holding only a legacy cookie sign out;
 * the first form, a bare canonical `token`, stays accepted so a web deployed
 * before this field keeps working.
 */
export const webSessionSignOutCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('signout'),
    payload: z.union([
      z.object({ token: sessionToken, ...expectedIdentity }).strict(),
      z.object({ presented: presentedWebSessionSchema, ...expectedIdentity }).strict(),
    ]),
  })
  .strict();

/**
 * Bridges a browser signed in before the switch: the joined NextAuth cookie
 * becomes a backend session with the cookie's own session id. Governed by
 * this mode alone on the backend; it does not read `AUTH_LEGACY_BRIDGE_MODE`.
 */
export const webSessionBridgeCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('bridge'),
    payload: z.object({ credential: z.string().min(1).max(LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH) }).strict(),
  })
  .strict();

/**
 * Reads the session the cookie carries, rolls it when fewer than 29 days
 * remain (the one place a web session rolls), and mints a browser access token
 * for it. A legacy cookie gets none: www bridges it first.
 */
export const webSessionAccessCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('access'),
    payload: z.object({ presented: presentedWebSessionSchema }).strict(),
  })
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

/**
 * The user fields today's NextAuth session JSON exposes (`session.user`): the
 * profile display name and avatar win over the account's own name and image.
 */
const sessionUser = z
  .object({ id: identityId, email: z.string().nullable(), name: z.string().nullable(), image: z.string().nullable() })
  .strict();

export const webSessionReadReplySchema = z.union([
  z
    .object({
      ...replyBase,
      operation: z.literal('session'),
      outcome: z.literal('active'),
      userId: identityId,
      authSessionId: identityId,
      generation: z.number().int().nonnegative().max(2_147_483_647),
      expiresAt: z.iso.datetime(),
      /** `login`: a sign-in this system verified. `bridge`: carried over from an older credential. */
      source: z.enum(['login', 'bridge']),
      /** The recorded sign-in time; null when unknown. Freshness also needs `source: 'login'`. */
      authenticatedAt: z.iso.datetime().nullable(),
      linkGuarded: z.boolean(),
      user: sessionUser,
    })
    .strict(),
  /** No live session: expired, revoked, cut off, deleted, or never issued. */
  z.object({ ...replyBase, operation: z.literal('session'), outcome: z.literal('unauthenticated') }).strict(),
  unavailableReply('session'),
]);

export const webSessionSignOutReplySchema = z.union([
  /** The session ended, or was not live to begin with. Clear the cookie. */
  z.object({ ...replyBase, operation: z.literal('signout'), outcome: z.literal('signed_out') }).strict(),
  /** The cookie now carries another session than the tab expected. Nothing ended; re-read the session. */
  z.object({ ...replyBase, operation: z.literal('signout'), outcome: z.literal('identity_changed') }).strict(),
  unavailableReply('signout'),
]);

export const webSessionBridgeReplySchema = z.union([
  /**
   * The bridged session. `token` is the same on every bridge of the same
   * legacy login, so a lost reply is recovered by bridging again. www puts it
   * in the bridged-session cookie and never logs it.
   */
  z
    .object({
      ...replyBase,
      operation: z.literal('bridge'),
      outcome: z.literal('bridged'),
      userId: identityId,
      sessionId: identityId,
      token: sessionToken,
      expiresAt: z.iso.datetime(),
      generation: z.number().int().nonnegative().max(2_147_483_647),
    })
    .strict(),
  /** The cookie cannot be bridged: forged, expired, signed out, cut off, deleted, or its row was replaced. */
  z.object({ ...replyBase, operation: z.literal('bridge'), outcome: z.literal('denied') }).strict(),
  unavailableReply('bridge'),
]);

export const webSessionAccessReplySchema = z.union([
  z
    .object({
      ...replyBase,
      operation: z.literal('access'),
      outcome: z.literal('active'),
      userId: identityId,
      authSessionId: identityId,
      /** The session row's expiry, after any roll. */
      expiresAt: z.iso.datetime(),
      rolled: z.boolean(),
      /** Hand it to page JavaScript; never log it. */
      accessToken: z.string().min(1).max(4096),
      accessTokenExpiresAt: z.iso.datetime(),
    })
    .strict(),
  /**
   * No access token. `no_session`: the cookie carries no live session; clear
   * it. `bridge_required`: a legacy cookie was presented, which this command
   * never reads; bridge it, then ask again with the bridged token.
   */
  z
    .object({
      ...replyBase,
      operation: z.literal('access'),
      outcome: z.literal('unauthenticated'),
      reason: z.enum(['no_session', 'bridge_required']),
    })
    .strict(),
  unavailableReply('access'),
]);

export type PresentedWebSession = z.infer<typeof presentedWebSessionSchema>;
export type WebSessionRequest = z.infer<typeof webSessionRequestSchema>;
export type IssuedWebSessionReply = z.infer<typeof issuedWebSessionSchema>;
export type WebSessionReadCommand = z.infer<typeof webSessionReadCommandSchema>;
export type WebSessionReadReply = z.infer<typeof webSessionReadReplySchema>;
export type WebSessionSignOutCommand = z.infer<typeof webSessionSignOutCommandSchema>;
export type WebSessionSignOutReply = z.infer<typeof webSessionSignOutReplySchema>;
export type WebSessionBridgeCommand = z.infer<typeof webSessionBridgeCommandSchema>;
export type WebSessionBridgeReply = z.infer<typeof webSessionBridgeReplySchema>;
export type WebSessionAccessCommand = z.infer<typeof webSessionAccessCommandSchema>;
export type WebSessionAccessReply = z.infer<typeof webSessionAccessReplySchema>;

/**
 * The status each reply is sent with. A 401 here always carries a body that
 * parses as the reply (`outcome: 'unauthenticated'`, or `denied` for a bridge). The transport's own 401
 * for a wrong secret is `{ error: 'unauthorized' }`, which never parses as a
 * reply, so a caller keys on the parsed body and never on the status alone.
 */
export function webSessionReplyStatus(
  reply: WebSessionReadReply | WebSessionSignOutReply | WebSessionBridgeReply | WebSessionAccessReply,
): number {
  if (reply.outcome === 'identity_changed') return 409;
  if (reply.outcome === 'unauthenticated' || reply.outcome === 'denied') return 401;
  if (reply.outcome === 'error') return 503;
  return 200;
}
