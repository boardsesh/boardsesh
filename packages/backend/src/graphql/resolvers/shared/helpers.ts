import type { ConnectionContext } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import { checkRateLimit, RateLimitError } from '../../../utils/rate-limiter';
import { checkRateLimitRedis } from '../../../utils/redis-rate-limiter';
import { getContext } from '../../context';
import { getDistributedState } from '../../../services/distributed-state';
import { db } from '../../../db/client';
import { esp32Controllers, boardSessionParticipants } from '@boardsesh/db/schema/app';
import { and, eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';

// Re-export validateInput / parseArrayTolerant from validation schemas
export { validateInput, parseArrayTolerant } from '../../../validation/schemas';
// Re-export MAX_RETRIES from types
export { MAX_RETRIES } from './types';
export { isNoMatchClimb, isNoMatch, usesAuroraNoMatchDescription } from '@boardsesh/shared-schema';

/**
 * Configuration for session membership retry behavior.
 *
 * With defaults (8 retries, 50ms initial delay):
 * - Delays: 50, 100, 200, 400, 800, 1600, 3200ms
 * - Total max wait: ~6.35 seconds
 *
 * GraphQL subscription timeout should exceed this value to avoid
 * subscription failures during high-latency join operations.
 */
export const SESSION_MEMBER_RETRY_CONFIG = {
  maxRetries: 8,
  initialDelayMs: 50,
} as const;

/**
 * Per-user rate-limit ceilings (requests/minute) for interactive party-session
 * traffic, on dedicated buckets separate from the shared `default` (60/min).
 *
 * Before #2763 every queue + wall-control mutation shared `default`, so a
 * two-person session exhausted it just by switching boulders (each swipe fans
 * out to ~2 mutations; the setCurrentClimb coalescer also fires addQueueItem
 * for superseded swipes) — every subsequent action then failed for up to 60s,
 * surfacing as "the connection fails every time we switch boulders".
 *
 * `RATE_LIMIT_SESSION` covers user-gesture-driven queue + wall-control
 * mutations; `RATE_LIMIT_PLAYBACK` isolates the per-frame publishPlaybackState
 * broadcast so a playing variable-speed climb can't starve climb switching.
 * Both are well above any human gesture rate (with fan-out) yet still cap a
 * runaway client. Playback allows up to 60 publishes/sec so route playback
 * sync can follow fast frame cadences without tripping the limiter. Mirrors
 * the existing per-operation buckets for
 * `confirmClimbOnWall` and `search-climbs`.
 */
export const RATE_LIMIT_SESSION_OP = 'session';
export const RATE_LIMIT_SESSION = 1200;
export const RATE_LIMIT_PLAYBACK_OP = 'playback';
export const RATE_LIMIT_PLAYBACK = 3600;
export const RATE_LIMIT_JOIN_SESSION_OP = 'joinSession';
export const RATE_LIMIT_JOIN_SESSION = 600;
export const RATE_LIMIT_CREATE_SESSION_OP = 'createSession';
export const RATE_LIMIT_CREATE_SESSION = 180;
export const RATE_LIMIT_END_SESSION_OP = 'endSession';
export const RATE_LIMIT_END_SESSION = 180;
export const RATE_LIMIT_CONFIRM_CLIMB_ON_WALL_OP = 'confirmClimbOnWall';
export const RATE_LIMIT_CONFIRM_CLIMB_ON_WALL = 600;
export const RATE_LIMIT_SET_QUEUE_OP = 'setQueue';
export const RATE_LIMIT_SET_QUEUE = 300;

/**
 * The TCP-peer bucket is a coarse direct-origin abuse backstop. Railway and
 * Cloudflare can fan many real clients into one peer address, so it must stay
 * well above the normal per-client limit while remaining finite.
 */
const ANONYMOUS_SOCKET_PEER_RATE_LIMIT_FLOOR = 600;
const ANONYMOUS_SOCKET_PEER_RATE_LIMIT_MULTIPLIER = 5;
// Keep every Redis tier for one operation on the same window; changing this
// means changing the windowMs passed to both calls below together.
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Helper to require a session context.
 * Throws if the user is not in a session.
 */
export function requireSession(ctx: ConnectionContext): string {
  if (!ctx.sessionId) {
    // Benign, high-volume race: a mutation fired on a connection that hasn't
    // (re)joined yet — the client's optimistic local reducer already applied
    // and the next reconnect FullSync reconciles. Logged at `debug` so it
    // stays out of prod error/warn dashboards (issue #2385).
    logger.debug('[Auth] requireSession denied: no session context', {
      connectionId: ctx.connectionId,
      reason: 'no-session-id' satisfies SessionMembershipDenialReason,
    });
    throw new Error(`Must be in a session to perform this operation (connectionId: ${ctx.connectionId})`);
  }
  return ctx.sessionId;
}

/**
 * Grace budget for `requireSessionWithReconnectGrace`. Four checks with
 * exponential backoff between them: 50 + 100 + 200 = ~350ms of total waiting
 * (the last check doesn't sleep), plus a final re-check. Well under the mutation
 * timeout, and above realistic reconnect + JOIN_SESSION latency.
 */
export const RECONNECT_GRACE_RETRY_CONFIG = {
  maxRetries: 4,
  initialDelayMs: 50,
} as const;

/**
 * Reconnect-tolerant `requireSession` for QUEUE mutations (#2397).
 *
 * On a socket drop graphql-ws auto-reconnects and the client re-issues
 * JOIN_SESSION on the fresh connection — but a queue mutation buffered by
 * graphql-ws can flush onto that new socket *before* its JOIN_SESSION binds
 * `ctx.sessionId`, tripping the synchronous `requireSession` guard even though
 * the client is legitimately (re)joining. The mutation carries no sessionId and
 * the fresh connection isn't bound until JOIN lands, so the server can't
 * recover it — but since the client always re-joins on the same connection
 * after a reconnect, the binding lands within a few ms.
 *
 * So when `ctx.sessionId` is already set (the overwhelmingly common case) we
 * return immediately — zero added latency on the hot path. When it's unset we
 * briefly poll the live per-connection context (and distributed state, for the
 * cross-instance case) for the imminent JOIN, mirroring `requireSessionMember`'s
 * subscription-side retry. If the budget expires we throw the same error
 * `requireSession` does, so a genuine "not in a session" caller still fails —
 * just after a bounded wait.
 */
export async function requireSessionWithReconnectGrace(
  ctx: ConnectionContext,
  maxRetries: number = RECONNECT_GRACE_RETRY_CONFIG.maxRetries,
  initialDelayMs: number = RECONNECT_GRACE_RETRY_CONFIG.initialDelayMs,
): Promise<string> {
  // Hot path: sessionId already bound on the operation's context.
  if (ctx.sessionId) {
    return ctx.sessionId;
  }

  for (let i = 0; i < maxRetries; i++) {
    // JOIN_SESSION binds sessionId via updateContext on the live per-connection
    // context; re-read it rather than trusting the (possibly pre-join) snapshot
    // this resolver was invoked with.
    const latestCtx = getContext(ctx.connectionId);
    if (latestCtx?.sessionId) {
      return latestCtx.sessionId;
    }

    // Cross-instance: the fresh connection may be tracked on another instance,
    // where JOIN wrote the binding into distributed state first.
    const distributedState = getDistributedState();
    if (distributedState) {
      try {
        const distributedConnection = await distributedState.getConnection(ctx.connectionId);
        if (distributedConnection?.sessionId) {
          return distributedConnection.sessionId;
        }
      } catch {
        // A Redis blip can't grant a session, but it mustn't end the wait
        // early either — fall through and retry / eventually throw.
      }
    }

    if (i < maxRetries - 1) {
      const delay = initialDelayMs * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Final re-check after the last backoff, then give up with the same error
  // `requireSession` throws.
  const finalCtx = getContext(ctx.connectionId);
  if (finalCtx?.sessionId) {
    return finalCtx.sessionId;
  }

  logger.warn('[Auth] requireSessionWithReconnectGrace failed after grace window', {
    connectionId: ctx.connectionId,
  });
  throw new Error(`Must be in a session to perform this operation (connectionId: ${ctx.connectionId})`);
}

/**
 * Helper to require authentication.
 * Throws if the user is not authenticated.
 * Used for operations that require a logged-in user (e.g., creating sessions).
 */
export function requireAuthenticated(ctx: ConnectionContext): void {
  if (!ctx.isAuthenticated) {
    throw new Error('Authentication required to perform this operation');
  }
}

/**
 * Extension `code` on every membership-denial error thrown by
 * `requireSessionMember`. Clients branch on this (via
 * `GraphQLOperationError.extensions.code`) to distinguish "you are not a
 * member of this session, stop retrying / clear it" from a transient
 * transport failure — instead of matching the message string. Mirrors the
 * `RATE_LIMITED` / `SESSION_ENDED` / `CLIMB_IS_DUPLICATE` extension pattern.
 */
export const NOT_SESSION_MEMBER_CODE = 'NOT_SESSION_MEMBER';

/**
 * Why a membership check was denied — carried in `extensions.reason` and the
 * structured debug log for triage (issue #2385 asked for a per-reason
 * breakdown). Kept deliberately coarse: the two cases below are the only ones
 * the server can tell apart. "Never joined", "join too slow", and "stale
 * subscriber to an emptied session" all present identically as `no-session-id`
 * — there is no server-side signal that separates them.
 */
export type SessionMembershipDenialReason = 'no-session-id' | 'session-mismatch';

/**
 * Durable "was ever a member" check: a single PK-indexed read of
 * `board_session_participants` for `(userId, sessionId)`. The row is written
 * on join and **never deleted on leave** (see
 * `room-manager/client-lifecycle.ts`), so this is a "was ever a member"
 * signal, not "is currently connected". Uses the PRIMARY client (`db`, not
 * `dbRead`) so a fresh join's row can't be missed via replica lag.
 *
 * Shared by the `session` query gate (`isSessionMember`, below) and
 * `requireSessionMember`'s WS fast-path (above), so both agree on exactly one
 * definition of durable membership.
 */
export async function isDurableSessionMember(userId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ sessionId: boardSessionParticipants.sessionId })
    .from(boardSessionParticipants)
    .where(and(eq(boardSessionParticipants.userId, userId), eq(boardSessionParticipants.sessionId, sessionId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Helper to verify user is a member of the session they're trying to access.
 * Used for subscription authorization.
 *
 * This function includes retry logic with exponential backoff to handle race conditions
 * where subscriptions may be authorized before joinSession has completed updating the context.
 *
 * In multi-instance mode, it also checks distributed state for cross-instance validation.
 *
 * A **durable fast-path** runs first for authenticated WebSocket connections:
 * graphql-ws auto-replays an active subscription onto a brand-new connection
 * after a socket drop, and that fresh `ConnectionContext.sessionId` is
 * `undefined` until the client's rejoin lands. An authenticated caller who
 * already holds a `board_session_participants` row (from a prior join) is a
 * member regardless of the new connection's join state, so we authorize
 * immediately instead of burning the full ~6.4s of retry backoff waiting for
 * the rejoin to propagate. This is the same past-participant trust signal
 * `isSessionMember` grants the `session` query (issues #2355 / #2385).
 *
 * HTTP callers are deliberately excluded from the fast-path (`transport
 * !== 'http'` gate): a stateless HTTP `eventsReplay` request must still prove
 * active connection membership, matching the pre-existing behavior pinned by
 * `session-query-gate.test.ts`. Anonymous callers have no durable identity and
 * fall through to the retry loop, which covers the legitimate first-join /
 * anonymous-reconnect propagation window.
 *
 * @see SESSION_MEMBER_RETRY_CONFIG for timing configuration details
 */
export async function requireSessionMember(
  ctx: ConnectionContext,
  sessionId: string,
  maxRetries = SESSION_MEMBER_RETRY_CONFIG.maxRetries,
  initialDelayMs = SESSION_MEMBER_RETRY_CONFIG.initialDelayMs,
): Promise<void> {
  // Durable membership fast-path (authenticated WS connections only). See the
  // JSDoc above for why this short-circuits the retry loop.
  if (ctx.transport !== 'http' && ctx.userId && (await isDurableSessionMember(ctx.userId, sessionId))) {
    return;
  }

  for (let i = 0; i < maxRetries; i++) {
    // First check local context (fast path for same-instance)
    const latestCtx = getContext(ctx.connectionId);
    if (latestCtx?.sessionId === sessionId) {
      return; // Success - session matches locally
    }

    // Check distributed state on each iteration
    // We re-fetch on each retry to handle cases where distributed state becomes available
    // after initial retries (e.g., Redis reconnection). The getDistributedState() call is
    // synchronous and cheap - it just returns a cached singleton reference.
    const distributedState = getDistributedState();
    if (distributedState) {
      const isInSession = await distributedState.isConnectionInSession(ctx.connectionId, sessionId);
      if (isInSession) {
        return; // Success - session matches in distributed state
      }
    }

    if (i < maxRetries - 1) {
      // Exponential backoff: 50ms, 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms
      // Total max wait: ~6.4 seconds
      const delay = initialDelayMs * Math.pow(2, i);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Final check after all retries - check both local and distributed state
  const finalCtx = getContext(ctx.connectionId);

  // Check distributed state one more time
  const distributedState = getDistributedState();
  if (distributedState) {
    const isInSession = await distributedState.isConnectionInSession(ctx.connectionId, sessionId);
    if (isInSession) {
      return; // Success via distributed state
    }
  }

  if (!finalCtx?.sessionId) {
    // Benign, high-volume race (stale subscriber / anonymous reconnect / slow
    // join). Logged at `debug` so it stays out of prod error/warn dashboards
    // — clients now branch on `extensions.code` instead of scraping this line
    // (issue #2385 suggestions 2 & 4).
    const reason: SessionMembershipDenialReason = 'no-session-id';
    logger.debug('[Auth] requireSessionMember denied: not in any session', {
      connectionId: ctx.connectionId,
      requestedSessionId: sessionId,
      reason,
      maxRetries,
    });
    throw new GraphQLError(
      `Unauthorized: not in any session (connectionId: ${ctx.connectionId}, requested: ${sessionId})`,
      { extensions: { code: NOT_SESSION_MEMBER_CODE, reason } },
    );
  }
  if (finalCtx.sessionId !== sessionId) {
    // Kept at `warn`: a connection joined to session A asking to subscribe to
    // session B is genuinely unusual (client bug), unlike the benign
    // no-session-id race above.
    const reason: SessionMembershipDenialReason = 'session-mismatch';
    logger.warn('[Auth] requireSessionMember denied: session mismatch', {
      connectionId: ctx.connectionId,
      currentSessionId: finalCtx.sessionId,
      requestedSessionId: sessionId,
      reason,
    });
    throw new GraphQLError(`Unauthorized: session mismatch (have: ${finalCtx.sessionId}, requested: ${sessionId})`, {
      extensions: { code: NOT_SESSION_MEMBER_CODE, reason },
    });
  }
}

/**
 * Non-throwing, single-shot membership check for the `session` query gate.
 *
 * Unlike `requireSessionMember`, this does NOT retry with backoff — it's read
 * by a query resolver that needs an immediate member/non-member decision to
 * choose between a full payload and a redacted preview, not to block a
 * mutation/subscription while `joinSession` context propagation catches up.
 * The retrying behavior stays exclusively on `requireSessionMember`.
 *
 * Checked in order, short-circuiting on the first match:
 *   1. Local context — the connection's tracked context has a matching
 *      `sessionId` (fast path, same backend instance).
 *   2. Distributed state — `isConnectionInSession` for a WS connection
 *      tracked on a different instance. A failed lookup (Redis blip) logs
 *      and falls through to 3 rather than throwing — an error can never
 *      grant membership, but it must not 500 the query either (that would
 *      take the mobile pre-join preview down with it).
 *   3. Durable participant record — PK lookup on `board_session_participants`
 *      (same predicate as `verifyWidgetSession` in widget-session-guard.ts).
 *      Only meaningful when `ctx.userId` is set. HTTP requests get a fresh
 *      `http-<uuid>` connectionId per request (see yoga.ts), so 1–2 can never
 *      match an HTTP caller — they skip straight here — and this is the only
 *      durable signal available for an authenticated one.
 *
 * Anonymous HTTP callers with no local/distributed match — including a
 * genuine past participant who isn't currently logged in — fall through to
 * `false`. There's no stable identity to check durably in that case; this is
 * an accepted degradation (they still get the invite-preview payload, not an
 * error).
 */
export async function isSessionMember(ctx: ConnectionContext, sessionId: string): Promise<boolean> {
  // HTTP requests are stateless — never in the local context map, never in
  // distributed state — so the connection-based checks can't match; skip
  // straight to the durable record.
  if (ctx.transport !== 'http') {
    const latestCtx = getContext(ctx.connectionId);
    if (latestCtx?.sessionId === sessionId) {
      return true;
    }

    const distributedState = getDistributedState();
    if (distributedState) {
      try {
        const isInSession = await distributedState.isConnectionInSession(ctx.connectionId, sessionId);
        if (isInSession) {
          return true;
        }
      } catch (error) {
        logger.warn('[Auth] isSessionMember: distributed-state check failed; falling through to durable check', {
          connectionId: ctx.connectionId,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (ctx.userId) {
    // Durable participant-row check (`isDurableSessionMember`, primary `db`):
    // the row is written on join, and reading it from a lagging replica could
    // demote a freshly-joined authenticated HTTP caller to the preview
    // payload. A single PK-indexed row read is cheap on the primary.
    //
    // Note this also grants the full payload to an authenticated WS
    // connection that holds a past-participant row but isn't currently
    // joined. Intentional: it's the same trust signal the HTTP resync path
    // accepts — that user could fetch the same payload over HTTP anyway,
    // and could simply rejoin. `requireSessionMember` reuses the exact same
    // check for its WS subscription fast-path.
    if (await isDurableSessionMember(ctx.userId, sessionId)) {
      return true;
    }
  }

  return false;
}

/**
 * Apply rate limiting to a connection.
 *
 * Two-tier enforcement strategy:
 *
 * 1. **In-memory** (all users): Fast synchronous check, per-instance.
 *    For authenticated users the key is `userId:operation`; for
 *    unauthenticated users it is `ip:<clientIp>:operation` on both transports
 *    (HTTP sets clientIp in yoga.ts, WebSocket in websocket/setup.ts since
 *    issue #2863), falling back to `connectionId` only when no client IP could
 *    be resolved. This provides immediate per-process protection and works
 *    even when Redis is down.
 *
 * 2. **Redis** (authenticated callers and anonymous WebSockets): Distributed
 *    enforcement across multiple backend instances. Authenticated callers key
 *    on userId; anonymous WebSockets key on the trusted-hop clientIp resolved
 *    during upgrade. Uses an atomic Lua script (INCR + EXPIRE) so counts are
 *    consistent cluster-wide.
 *
 *    Anonymous HTTP deliberately stays on Tier 1 only. Since issue #4034 both
 *    transports resolve clientIp through the same trusted-hop resolver, so the
 *    trust boundary no longer blocks it — extending Tier 2 to anonymous HTTP is
 *    now a cost/benefit call (one Redis round-trip on every anonymous HTTP
 *    request vs. limits that currently scale with instance count) and is left
 *    open on #4034 rather than folded into that fix.
 *
 * Callers are checked by *both* tiers intentionally:
 * the in-memory check is a fast short-circuit that avoids a Redis
 * round-trip when the user is clearly over the limit on this instance,
 * while Redis ensures the limit holds across all instances.
 *
 * Anonymous WebSocket callers also get a high-ceiling Redis bucket keyed on
 * socketPeerIp. That address cannot be supplied in a request header, so a
 * direct-origin caller forging cf-connecting-ip still hits a finite shared
 * ceiling. Hosted proxy fan-in is why this secondary limit is intentionally
 * much higher than the per-client bucket.
 *
 * @param ctx - Connection context
 * @param limit - Optional custom limit (default: 60 requests per minute)
 * @param operation - Operation name for Redis key namespacing (default: 'default')
 */
export async function applyRateLimit(ctx: ConnectionContext, limit?: number, operation = 'default'): Promise<void> {
  if (process.env.NODE_ENV === 'development') return;

  const maxRequests = limit ?? 60;

  // Tier 1: Synchronous in-memory rate limiting (fast path, per-instance)
  // Use userId for authenticated users, clientIp for anonymous HTTP requests,
  // or connectionId as fallback (WebSocket connections)
  let key: string;
  if (ctx.isAuthenticated && ctx.userId) {
    key = `${ctx.userId}:${operation}`;
  } else if (ctx.clientIp) {
    key = `ip:${ctx.clientIp}:${operation}`;
  } else {
    key = ctx.connectionId;
  }

  // Surface a structured RATE_LIMITED error (with retryAfterSeconds) so clients
  // can branch on `extensions.code` instead of message-string matching, and the
  // generic "Action failed" toast can be replaced with a specific, gentle
  // message. Mirrors the CLIMB_IS_DUPLICATE extension pattern. The message text
  // is preserved for older clients. See #2763.
  try {
    // Tier 1: Synchronous in-memory rate limiting (fast path, per-instance)
    checkRateLimit(key, maxRequests);

    // Tier 2: Distributed Redis rate limiting. Tier 1 already ran, so Redis
    // failures must not increment the same in-memory bucket a second time.
    if (ctx.isAuthenticated && ctx.userId) {
      await checkRateLimitRedis(ctx.userId, operation, maxRequests, RATE_LIMIT_WINDOW_MS, {
        fallbackToMemory: false,
      });
    } else if (ctx.transport === 'ws' && ctx.clientIp) {
      await checkRateLimitRedis(`ip:${ctx.clientIp}`, operation, maxRequests, RATE_LIMIT_WINDOW_MS, {
        fallbackToMemory: false,
      });
    }

    // A rejected client/user bucket intentionally short-circuits before this
    // secondary peer bucket: the request is already blocked and must not spend
    // another identity's shared-proxy quota. Header rotation keeps reaching this
    // call because each forged client bucket remains below its own limit.
    if (!ctx.isAuthenticated && ctx.transport === 'ws' && ctx.socketPeerIp) {
      const socketPeerLimit = Math.max(
        ANONYMOUS_SOCKET_PEER_RATE_LIMIT_FLOOR,
        maxRequests * ANONYMOUS_SOCKET_PEER_RATE_LIMIT_MULTIPLIER,
      );
      await checkRateLimitRedis(`socket-peer:${ctx.socketPeerIp}`, operation, socketPeerLimit, RATE_LIMIT_WINDOW_MS, {
        fallbackToMemory: true,
      });
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'RATE_LIMITED', operation, retryAfterSeconds: error.retryAfterSeconds },
      });
    }
    throw error;
  }
}

/**
 * Helper to require controller authentication via connectionParams.
 * Throws if the connection is not authenticated as a controller.
 */
export function requireControllerAuth(ctx: ConnectionContext): {
  controllerId: string;
  controllerApiKey: string;
} {
  if (!ctx.controllerId || !ctx.controllerApiKey) {
    throw new Error('Controller authentication required. Pass controllerApiKey in connectionParams.');
  }
  return { controllerId: ctx.controllerId, controllerApiKey: ctx.controllerApiKey };
}

/**
 * Helper to verify a controller is authorized for a specific session.
 *
 * Controllers are authorized if:
 * 1. The controller exists and is authenticated via API key (already verified in connectionParams)
 * 2. The session exists and is active
 *
 * The API key is the authorization - if you have it, you registered the controller
 * and can use it with any session you want to monitor. The session ID in the ESP32
 * config determines which session the controller connects to.
 */
export async function requireControllerAuthorizedForSession(
  ctx: ConnectionContext,
  sessionId: string,
): Promise<{ controllerId: string; controllerApiKey: string }> {
  const { controllerId, controllerApiKey } = requireControllerAuth(ctx);

  // Verify the controller still exists (it was already authenticated via connectionParams)
  const [controller] = await db.select().from(esp32Controllers).where(eq(esp32Controllers.id, controllerId)).limit(1);

  if (!controller) {
    throw new Error('Controller not found');
  }

  // Update the controller's authorized session (for tracking purposes)
  // This also serves as a "last used session" record
  await db
    .update(esp32Controllers)
    .set({ authorizedSessionId: sessionId })
    .where(eq(esp32Controllers.id, controllerId));

  return { controllerId, controllerApiKey };
}
