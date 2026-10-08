import type { ConnectionContext } from '@boardsesh/shared-schema';
import { activityPushTokens } from '@boardsesh/db/schema/app';
import { boardSessionParticipants } from '../../../db/schema';
import { and, count, eq, lt, sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import {
  incrementApnsMetric,
  isApnsConfigured,
  sendLiveActivityUpdateToTokens,
  type LiveActivityContentState,
} from '../../../services/apns';
import { buildContentStateFromQueueState } from '../../../services/apns/content-state';
import { roomManager } from '../../../services/room-manager';
import { trackLiveActivityEnded, trackLiveActivityStarted } from '../../../services/analytics/live-activity';
import { logger } from '../../../utils/logger';
import { requireResourceAccess } from '../../../services/privacy';

/**
 * APNs device tokens are hex-encoded byte blobs. Classic remote-notification
 * tokens are 32 bytes (64 hex chars), but ActivityKit Live Activity tokens
 * observed on iOS 17.2+ are 80 bytes (160 hex chars), and Apple may grow them
 * further. We accept a wide 32–512 hex-char range so a future token-format
 * bump doesn't break registration, while still rejecting obviously malformed
 * input (non-hex, way too short, or absurdly long).
 */
const APNS_TOKEN_PATTERN = /^[0-9a-fA-F]{32,512}$/;

/** Per-session cap on registered push tokens. Bounds blast radius if a single
 *  session somehow accumulates many tokens (e.g. user reinstalls repeatedly). */
const MAX_TOKENS_PER_SESSION = 8;

/**
 * Advisory-lock namespace for push-token operations. `pg_advisory_xact_lock`
 * uses a global lock space, so two unrelated callers that hash to the same
 * 32-bit key contend on the same lock. The two-int form namespaces the lock
 * by an arbitrary first arg — `0x70757368` is ASCII "push". Any other
 * advisory-lock user in this codebase should pick a distinct namespace.
 */
const PUSH_TOKEN_LOCK_NAMESPACE = 0x70757368;

/**
 * Eviction freshness window. When the cap is hit we only evict tokens that
 * haven't been touched in over an hour, so a burst of fresh registrations
 * cannot wipe an active device's still-valid token. If every slot is
 * fresh-but-saturated (8 distinct active devices in one session), the new
 * registration is rejected with a clear error and iOS retries later via the
 * pending-registration flow in `LiveActivityPlugin.swift`.
 */
const EVICTION_FRESHNESS_WINDOW_MS = 60 * 60 * 1000;

/**
 * Per-(userId, sessionId) token bucket protecting the push-token mutations
 * from authenticated-but-abusive write floods.
 *
 * The mutations are auth-gated and participant-checked, but auth alone doesn't
 * bound write traffic — a participant can still flood register/unregister and
 * churn the activity_push_tokens table. Bucket: 5 capacity, refill 1 token /
 * 2s. So 5 rapid mutations succeed; sustained traffic is limited to ~30
 * req/min per (user, session).
 *
 * In-memory only — defense-in-depth, not a hard quota. The cap of 8 tokens
 * per session in the upsert path is the authoritative bound on DB row count.
 */
const TOKEN_MUTATION_BUCKET_CAPACITY = 5;
const TOKEN_MUTATION_REFILL_PER_SECOND = 1 / 2;
const TOKEN_MUTATION_BUCKET_TTL_MS = 5 * 60 * 1000;
const TOKEN_MUTATION_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface TokenMutationBucket {
  tokens: number;
  lastRefillMs: number;
}

const tokenMutationBuckets = new Map<string, TokenMutationBucket>();
let prunerHandle: ReturnType<typeof setInterval> | null = null;

function ensurePrunerRunning(): void {
  if (prunerHandle !== null) return;
  prunerHandle = setInterval(() => {
    const cutoff = Date.now() - TOKEN_MUTATION_BUCKET_TTL_MS;
    for (const [key, bucket] of tokenMutationBuckets) {
      if (bucket.lastRefillMs < cutoff) {
        tokenMutationBuckets.delete(key);
      }
    }
  }, TOKEN_MUTATION_PRUNE_INTERVAL_MS);
  if (typeof prunerHandle.unref === 'function') prunerHandle.unref();
}

function checkTokenMutationRateLimit(userId: string, sessionId: string): boolean {
  ensurePrunerRunning();
  const key = `${userId}:${sessionId}`;
  const now = Date.now();
  const existing = tokenMutationBuckets.get(key);

  if (!existing) {
    tokenMutationBuckets.set(key, { tokens: TOKEN_MUTATION_BUCKET_CAPACITY - 1, lastRefillMs: now });
    return true;
  }

  const elapsedSeconds = (now - existing.lastRefillMs) / 1000;
  const refilled = Math.min(
    TOKEN_MUTATION_BUCKET_CAPACITY,
    existing.tokens + elapsedSeconds * TOKEN_MUTATION_REFILL_PER_SECOND,
  );
  existing.lastRefillMs = now;

  if (refilled < 1) {
    existing.tokens = refilled;
    return false;
  }
  existing.tokens = refilled - 1;
  return true;
}

/** Test-only utility for clearing in-memory rate-limit state between tests. */
export function __resetPushTokenRateLimitForTests(): void {
  tokenMutationBuckets.clear();
  if (prunerHandle !== null) {
    clearInterval(prunerHandle);
    prunerHandle = null;
  }
}

/**
 * Verify that the authenticated user has joined the session at some point.
 * Reads from `board_session_participants`, which is the permanent (non-disconnect)
 * record of session participation written by the room manager on join.
 */
async function isParticipant(userId: string, sessionId: string): Promise<boolean> {
  const rows = await db
    .select({ sessionId: boardSessionParticipants.sessionId })
    .from(boardSessionParticipants)
    .where(and(eq(boardSessionParticipants.userId, userId), eq(boardSessionParticipants.sessionId, sessionId)))
    .limit(1);
  return rows.length > 0;
}

function describeTokenForLog(token: string): string {
  return `${token.slice(0, 8)}...`;
}

function describeSessionForLog(sessionId: string | null | undefined): string {
  return sessionId || '<missing>';
}

async function buildContentStateForSession(sessionId: string): Promise<LiveActivityContentState | null> {
  try {
    const queueState = await roomManager.getQueueState(sessionId);
    return buildContentStateFromQueueState(queueState);
  } catch (error) {
    logger.warn(`[APNs] Failed to build content state for session ${sessionId} during token registration:`, error);
    return null;
  }
}

export const pushTokenMutations = {
  /**
   * Register (upsert) an APNs device token for Live Activity push updates.
   * Requires authentication and that the caller is a participant in the session.
   * If the token already exists, updates the associated sessionId and updatedAt.
   *
   * On success, immediately dispatches a single APNs push to the newly
   * registered token so the lock-screen widget shows real content instead of
   * "Loading…" without waiting for the next organic queue event.
   */
  registerActivityPushToken: async (
    _: unknown,
    { sessionId, token }: { sessionId: string; token: string },
    ctx: ConnectionContext,
  ) => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      logger.warn(
        `[APNs] Rejected Live Activity token registration for session ${describeSessionForLog(sessionId)}: unauthenticated`,
      );
      throw new Error('Authentication required to perform this operation');
    }

    if (!sessionId || !token) {
      logger.warn(
        `[APNs] Rejected Live Activity token registration for session ${describeSessionForLog(sessionId)}: missing sessionId or token`,
      );
      throw new Error('sessionId and token are required');
    }

    if (!APNS_TOKEN_PATTERN.test(token)) {
      logger.warn(
        `[APNs] Rejected Live Activity token registration for session ${sessionId}: invalid token format (length ${String(token.length)})`,
      );
      throw new Error('Invalid APNs token format');
    }

    if (!checkTokenMutationRateLimit(ctx.userId, sessionId)) {
      logger.warn(
        `[APNs] Rejected Live Activity token registration for session ${sessionId}: rate limited user ${ctx.userId}`,
      );
      throw new Error('Too many push-token requests, please retry later');
    }

    if (!(await isParticipant(ctx.userId, sessionId))) {
      logger.warn(
        `[APNs] Rejected Live Activity token registration for session ${sessionId}: user ${ctx.userId} is not a participant`,
      );
      throw new Error('Unauthorized: not a participant in this session');
    }

    await requireResourceAccess('session', sessionId, ctx.userId);

    // Bound the number of tokens per session and detect rebinding.
    //
    // Run lookup + (optional) eviction + insert inside one transaction with a
    // per-session Postgres advisory lock so concurrent registrations against
    // the same session serialize at the lock. Without this, two requests could
    // both observe currentCount = cap - 1, both skip the eviction, and both
    // insert, ending up at cap + 1. The advisory lock auto-releases at
    // transaction end (`_xact_` variant) so we don't have to clean up on
    // error paths.
    let previousTokenSessionId: string | null = null;

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PUSH_TOKEN_LOCK_NAMESPACE}, hashtext(${sessionId}))`);

        // F4: detect token rebinding. Reading the existing row inside the
        // lock means we get a consistent before/after view in the same txn.
        const existingRows = await tx
          .select({ sessionId: activityPushTokens.sessionId })
          .from(activityPushTokens)
          .where(eq(activityPushTokens.token, token))
          .limit(1);
        previousTokenSessionId = existingRows[0]?.sessionId ?? null;
        if (previousTokenSessionId && previousTokenSessionId !== sessionId) {
          incrementApnsMetric('tokensRebound');
          logger.warn(
            `[APNs] Rebound token ${describeTokenForLog(token)} from session ${previousTokenSessionId} → ${sessionId} (user ${ctx.userId})`,
          );
        }

        const [{ value: currentCount } = { value: 0 }] = await tx
          .select({ value: count() })
          .from(activityPushTokens)
          .where(eq(activityPushTokens.sessionId, sessionId));

        // Only enforce the cap if this is a *new* registration for the
        // session. A rebind/upsert of an existing token doesn't grow the row
        // count, so it should never be blocked by the cap.
        const isNewRegistration = previousTokenSessionId !== sessionId;
        if (isNewRegistration && currentCount >= MAX_TOKENS_PER_SESSION) {
          const evictionCount = currentCount - MAX_TOKENS_PER_SESSION + 1;
          const freshnessCutoff = new Date(Date.now() - EVICTION_FRESHNESS_WINDOW_MS);
          const oldest = await tx
            .select({ token: activityPushTokens.token })
            .from(activityPushTokens)
            .where(and(eq(activityPushTokens.sessionId, sessionId), lt(activityPushTokens.updatedAt, freshnessCutoff)))
            .orderBy(activityPushTokens.updatedAt)
            .limit(evictionCount);

          if (oldest.length < evictionCount) {
            // Every slot is occupied by a fresh registration. Refuse rather
            // than evict a still-valid token. iOS will retry later.
            logger.warn(
              `[APNs] Refusing Live Activity token registration for session ${sessionId}: ` +
                `all ${String(MAX_TOKENS_PER_SESSION)} slots used by tokens registered within the last hour`,
            );
            throw new Error('Too many active devices for this session right now; please retry shortly');
          }

          logger.warn(
            `[APNs] Evicting ${String(oldest.length)} old Live Activity token(s) for session ${sessionId}; cap is ${String(MAX_TOKENS_PER_SESSION)}`,
          );
          for (const row of oldest) {
            await tx.delete(activityPushTokens).where(eq(activityPushTokens.token, row.token));
            incrementApnsMetric('tokensEvicted');
          }
        }

        await tx
          .insert(activityPushTokens)
          .values({
            token,
            sessionId,
            userId: ctx.userId,
          })
          .onConflictDoUpdate({
            target: activityPushTokens.token,
            set: {
              sessionId,
              userId: ctx.userId,
              updatedAt: new Date(),
            },
          });
      });
    } catch (error) {
      logger.error(
        `[APNs] Failed to register Live Activity token for session ${sessionId} (${describeTokenForLog(token)}):`,
        error,
      );
      throw error;
    }

    incrementApnsMetric('tokensRegistered');
    logger.info(`[APNs] Registered Live Activity token for session ${sessionId}: ${describeTokenForLog(token)}`);
    trackLiveActivityStarted({
      sessionId,
      tokenLength: token.length,
      apnsConfigured: isApnsConfigured(),
      tokenPreviouslyRegistered: previousTokenSessionId !== null,
      tokenRebound: previousTokenSessionId !== null && previousTokenSessionId !== sessionId,
    });

    // F3: fire a single, debounce-bypassing APNs push to the newly registered
    // token so the widget exits "Loading…" right away. Fire-and-forget — the
    // resolver still returns `true` even if the immediate send fails, because
    // the next queue event or the heartbeat loop will pick up the slack.
    if (isApnsConfigured()) {
      void (async () => {
        const state = await buildContentStateForSession(sessionId);
        if (!state) return;
        try {
          await sendLiveActivityUpdateToTokens(sessionId, [{ token, userId: ctx.userId ?? null }], state, {
            source: 'registration',
          });
        } catch (error) {
          logger.warn(
            `[APNs] Failed initial Live Activity send for session ${sessionId} (${describeTokenForLog(token)}):`,
            error,
          );
        }
      })();
    }

    return true;
  },

  /**
   * Unregister an APNs device token by deleting it from the database.
   * Requires authentication and that the caller is a participant in `sessionId`.
   * The delete is scoped to (token, sessionId) so an attacker holding a leaked
   * token cannot wipe another session's registration.
   */
  unregisterActivityPushToken: async (
    _: unknown,
    { sessionId, token }: { sessionId: string; token: string },
    ctx: ConnectionContext,
  ) => {
    if (!ctx.isAuthenticated || !ctx.userId) {
      logger.warn(
        `[APNs] Rejected Live Activity token unregister for session ${describeSessionForLog(sessionId)}: unauthenticated`,
      );
      throw new Error('Authentication required to perform this operation');
    }

    if (!sessionId || !token) {
      logger.warn(
        `[APNs] Rejected Live Activity token unregister for session ${describeSessionForLog(sessionId)}: missing sessionId or token`,
      );
      throw new Error('sessionId and token are required');
    }

    if (!APNS_TOKEN_PATTERN.test(token)) {
      logger.warn(
        `[APNs] Rejected Live Activity token unregister for session ${sessionId}: invalid token format (length ${String(token.length)})`,
      );
      throw new Error('Invalid APNs token format');
    }

    if (!checkTokenMutationRateLimit(ctx.userId, sessionId)) {
      logger.warn(
        `[APNs] Rejected Live Activity token unregister for session ${sessionId}: rate limited user ${ctx.userId}`,
      );
      throw new Error('Too many push-token requests, please retry later');
    }

    if (!(await isParticipant(ctx.userId, sessionId))) {
      logger.warn(
        `[APNs] Rejected Live Activity token unregister for session ${sessionId}: user ${ctx.userId} is not a participant`,
      );
      throw new Error('Unauthorized: not a participant in this session');
    }

    try {
      await db
        .delete(activityPushTokens)
        .where(and(eq(activityPushTokens.token, token), eq(activityPushTokens.sessionId, sessionId)));
    } catch (error) {
      logger.error(
        `[APNs] Failed to unregister Live Activity token for session ${sessionId} (${describeTokenForLog(token)}):`,
        error,
      );
      throw error;
    }

    logger.info(`[APNs] Unregistered Live Activity token for session ${sessionId}: ${describeTokenForLog(token)}`);
    trackLiveActivityEnded({
      sessionId,
      reason: 'unregister',
    });

    return true;
  },
};
