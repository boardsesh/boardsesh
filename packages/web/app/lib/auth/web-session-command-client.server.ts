import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  WEB_SESSION_COMMAND_PATHS,
  WEB_SESSION_PROTOCOL_VERSION,
  webSessionAccessReplySchema,
  webSessionBridgeReplySchema,
  webSessionReadReplySchema,
  webSessionReplyStatus,
  webSessionSignOutReplySchema,
  type PresentedWebSession,
  type WebSessionAccessReply,
  type WebSessionBridgeReply,
  type WebSessionReadReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

export { AuthBackendUnavailableError } from './auth-command-transport.server';

export type ActiveWebSession = Extract<WebSessionReadReply, { outcome: 'active' }>;

/** A live session, or a confirmed "no live session". Anything else throws `AuthBackendUnavailableError`. */
export type WebSessionReadResult = { status: 'active'; session: ActiveWebSession } | { status: 'signed-out' };

export type BridgedWebSession = Extract<WebSessionBridgeReply, { outcome: 'bridged' }>;

/** The bridged session, or a confirmed "this cookie cannot be bridged". Anything else throws. */
export type WebSessionBridgeResult = { status: 'bridged'; session: BridgedWebSession } | { status: 'denied' };

export type BrowserAccessGrant = Extract<WebSessionAccessReply, { outcome: 'active' }>;

/**
 * A 15-minute browser access token for the presented session (B3a's `access`),
 * or a confirmed answer that there is none: `no-session` (the cookie carries no
 * live session) or `bridge-required` (a legacy cookie, which `access` never
 * reads). Anything else throws.
 */
export type WebSessionAccessResult =
  | { status: 'active'; grant: BrowserAccessGrant }
  | { status: 'no-session' }
  | { status: 'bridge-required' };

export type WebSessionCommandClient = {
  /** The browser access token for a session; the one place a web session rolls. Never logs the token. */
  access(presented: PresentedWebSession): Promise<WebSessionAccessResult>;
  /** The joined legacy NextAuth cookie, as received; at most `LEGACY_WEB_SESSION_CREDENTIAL_MAX_LENGTH`. */
  bridge(credential: string): Promise<WebSessionBridgeResult>;
  read(presented: PresentedWebSession): Promise<WebSessionReadResult>;
  signOut(
    presented: PresentedWebSession,
    expected: { userId: string; authSessionId: string },
  ): Promise<'signed_out' | 'identity_changed'>;
};

/**
 * The backend's `session`, `signout`, `bridge` and `access` web-session commands (#7596), on the
 * same private channel and secret as the staged password command. One request
 * each, no retry: a lost sign-out reply may follow a commit.
 *
 * Only a reply whose body parses as the command's own reply, with the status
 * that reply is sent with, counts. The transport's 401 `{ error: 'unauthorized' }`
 * (wrong secret, a browser Origin), a 404 `disabled`, a timeout or any body
 * that does not parse is "unavailable", never "signed out", so no caller ever
 * clears a cookie on a status alone.
 */
export function createWebSessionCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): WebSessionCommandClient {
  const transport = createAuthCommandTransport({
    ...options,
    paths: Object.values(WEB_SESSION_COMMAND_PATHS),
  });
  function metadata() {
    return { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId: randomUUID(), issuedAt: Date.now() };
  }

  return {
    async access(presented) {
      try {
        const command = { ...metadata(), operation: 'access' as const, payload: { presented } };
        const response = await transport.post(WEB_SESSION_COMMAND_PATHS.access, command);
        const reply = webSessionAccessReplySchema.parse(response.body);
        if (reply.requestId !== command.requestId || webSessionReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        if (reply.outcome === 'active') return { status: 'active', grant: reply };
        if (reply.outcome === 'unauthenticated')
          return { status: reply.reason === 'no_session' ? 'no-session' : 'bridge-required' };
        throw new AuthBackendUnavailableError();
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
    async bridge(credential) {
      try {
        const command = { ...metadata(), operation: 'bridge' as const, payload: { credential } };
        const response = await transport.post(WEB_SESSION_COMMAND_PATHS.bridge, command);
        const reply = webSessionBridgeReplySchema.parse(response.body);
        if (reply.requestId !== command.requestId || webSessionReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        if (reply.outcome === 'bridged') return { status: 'bridged', session: reply };
        if (reply.outcome === 'denied') return { status: 'denied' };
        throw new AuthBackendUnavailableError();
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
    async read(presented) {
      try {
        const command = { ...metadata(), operation: 'session' as const, payload: { presented } };
        const response = await transport.post(WEB_SESSION_COMMAND_PATHS.session, command);
        const reply = webSessionReadReplySchema.parse(response.body);
        if (reply.requestId !== command.requestId || webSessionReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        if (reply.outcome === 'active') return { status: 'active', session: reply };
        if (reply.outcome === 'unauthenticated') return { status: 'signed-out' };
        throw new AuthBackendUnavailableError();
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
    async signOut(presented, expected) {
      try {
        const command = {
          ...metadata(),
          operation: 'signout' as const,
          payload: { presented, expectedUserId: expected.userId, expectedAuthSessionId: expected.authSessionId },
        };
        const response = await transport.post(WEB_SESSION_COMMAND_PATHS.signout, command);
        const reply = webSessionSignOutReplySchema.parse(response.body);
        if (reply.requestId !== command.requestId || webSessionReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        if (reply.outcome === 'signed_out' || reply.outcome === 'identity_changed') return reply.outcome;
        throw new AuthBackendUnavailableError();
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
