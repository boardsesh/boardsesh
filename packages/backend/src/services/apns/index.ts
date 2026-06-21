/**
 * APNs Live Activity Push Notification Service
 *
 * Sends ActivityKit push notifications to update iOS Live Activity widgets
 * when queue state changes during climbing sessions.
 *
 * Uses @parse/node-apn for token-based APNs authentication.
 * Gracefully degrades when APNs env vars are not configured.
 */

import apn from '@parse/node-apn';
import { eq } from 'drizzle-orm';
import { activityPushTokens } from '@boardsesh/db/schema/app';
import { db } from '../../db/client';
import {
  trackLiveActivityEnded,
  trackLiveActivityEndedAttributionGap,
  trackLiveActivityPushDelivery,
  trackLiveActivityPushDeliveryAttributionGap,
} from '../analytics/live-activity';
import { logger } from '../../utils/logger';
import { type BoardHolder, deriveBoardConnection } from './board-connection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveActivityContentState {
  climbName: string;
  climbDifficulty: string;
  angle: number;
  currentIndex: number;
  totalClimbs: number;
  hasNext: boolean;
  hasPrevious: boolean;
  climbUuid: string;
  /**
   * Per-token board-connection state, derived from the board's current holder
   * (see board-connection.ts). OPTIONAL on the device: when omitted, iOS falls
   * back to its own App-Group state. The base `buildContentStateFromQueueState`
   * never sets these — they're stamped per-group at send time once the holder is
   * resolved (see `sendGroupedNotification`).
   */
  boardConnection?: 'connectedByMe' | 'heldByPeer' | 'disconnected';
  /** The peer holder's display name; only set alongside `heldByPeer`. */
  holderDisplayName?: string;
}

/**
 * Resolves the current board holder for a session, or null when it can't be
 * determined (no board mapping, no Redis, anonymous-only holder, or a lookup
 * error). Injected at server startup via `setSessionHolderResolver` so this
 * module stays decoupled from pubsub/Redis and is unit-testable. When the
 * resolver returns null the send path OMITS boardConnection (device falls back
 * to its own App-Group state).
 */
export type SessionHolderResolver = (sessionId: string) => Promise<BoardHolder | null>;

/** Source attribution for the structured per-send log line. */
type SendSource = 'event' | 'heartbeat' | 'registration';

interface DebouncedEntry {
  timeout: ReturnType<typeof setTimeout>;
  latestState: LiveActivityContentState;
  /** Index into DB_RETRY_DELAYS_MS for the next retry. */
  dbRetryAttempt: number;
  /** Last `source` passed to `sendLiveActivityUpdate` for this entry. The
   *  latest call wins on coalesce — same convention as `latestState`. */
  source: SendSource;
}

export interface LiveActivityTokenRegistration {
  token: string;
  userId: string | null;
}

interface DeliveryCounts {
  tokenCount: number;
  sentCount: number;
  failedCount: number;
  staleCount: number;
}

interface DeliveryTrackingInput {
  sessionId: string;
  event: 'update' | 'end';
  source: SendSource;
  registrations: LiveActivityTokenRegistration[];
  sentDevices: string[];
  failedDevices: string[];
  staleDevices: ReadonlySet<string>;
  elapsedMs: number;
}

// Exponential-ish backoff schedule for transient DB lookup failures.
// 3 retries with growing delays gives ~14 s of total wait before giving up,
// which is enough to ride out a brief connection-pool blip or Postgres
// failover without dropping the update.
const DEFAULT_DB_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

// 1 s debounce. Climb navigation needs to feel responsive on the lock screen;
// a 5 s window made tapping Next visibly laggy. 1 s still absorbs the most
// common burst (QueueItemAdded + CurrentClimbChanged emitted back-to-back when
// a climb is queued). A restart inside this 1 s window can drop the pending
// update; the heartbeat loop catches up within 90 s.
const DEFAULT_DEBOUNCE_MS = 1_000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let provider: apn.Provider | null = null;
let bundleId: string = '';
let configured = false;

/**
 * The injected board-holder resolver. Wired at server startup so the send path
 * can resolve a session's holder ONCE per send and stamp each token's
 * boardConnection. Null until wired (and in tests that don't set it), in which
 * case boardConnection is omitted and devices fall back to their own state.
 */
let sessionHolderResolver: SessionHolderResolver | null = null;

/**
 * Wire the board-holder resolver. Called once at server startup with a closure
 * over pubsub (see server.ts). Keeps this module free of a direct pubsub/Redis
 * dependency and lets tests inject a deterministic holder.
 */
export function setSessionHolderResolver(resolver: SessionHolderResolver | null): void {
  sessionHolderResolver = resolver;
}

// Mutable so tests can shrink the windows to milliseconds rather than awaiting
// the production-grade 1 s debounce + multi-second retry delays against real
// timers (faking setTimeout deadlocks postgres-js's connection pool). In prod
// these stay at DEFAULT_* and are reset by __resetApnsForTests.
let DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
let DB_RETRY_DELAYS_MS: readonly number[] = DEFAULT_DB_RETRY_DELAYS_MS;

/** Returns true if APNs env vars were present and the provider initialized. */
export function isApnsConfigured(): boolean {
  return configured;
}

/** Debounce map: sessionId -> pending send state */
const pendingSends = new Map<string, DebouncedEntry>();

/** Whether a session currently has a pending debounced send in flight. */
export function hasPendingSend(sessionId: string): boolean {
  return pendingSends.has(sessionId);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

interface ApnsMetrics {
  tokensRegistered: number;
  tokensEvicted: number;
  tokensRebound: number;
  /** Stale tokens removed via the live-send 410 / BadDeviceToken path. */
  tokensRemovedOn410: number;
  /** Stale tokens removed via the scheduled `apns/cleanup.ts` daily sweep. */
  tokensSweptStale: number;
  sendsAttempted: number;
  sendsSucceeded: number;
  sendsFailed: number;
  sendsCoalesced: number;
  heartbeatsSent: number;
  dbRetriesUsed: number;
}

const metrics: ApnsMetrics = {
  tokensRegistered: 0,
  tokensEvicted: 0,
  tokensRebound: 0,
  tokensRemovedOn410: 0,
  tokensSweptStale: 0,
  sendsAttempted: 0,
  sendsSucceeded: 0,
  sendsFailed: 0,
  sendsCoalesced: 0,
  heartbeatsSent: 0,
  dbRetriesUsed: 0,
};

export function getApnsMetrics(): ApnsMetrics & { configured: boolean; pendingSendsInFlight: number } {
  return {
    ...metrics,
    configured,
    pendingSendsInFlight: pendingSends.size,
  };
}

export function incrementApnsMetric(key: keyof ApnsMetrics, delta = 1): void {
  metrics[key] += delta;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the APNs provider.
 * Call once at server startup. If required env vars are missing the module
 * becomes a silent no-op — every public function returns immediately.
 */
export function initializeApns(): void {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyContentsBase64 = process.env.APNS_KEY_CONTENTS;
  const envBundleId = process.env.APNS_BUNDLE_ID;
  const production = process.env.APNS_PRODUCTION === 'true';

  if (!keyId || !teamId || !keyContentsBase64 || !envBundleId) {
    logger.warn(
      '[APNs] Missing one or more required env vars (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_CONTENTS, APNS_BUNDLE_ID). ' +
        'Live Activity push notifications are disabled.',
    );
    return;
  }

  bundleId = envBundleId;

  const keyContents = Buffer.from(keyContentsBase64, 'base64').toString('utf-8');

  provider = new apn.Provider({
    token: {
      key: keyContents,
      keyId,
      teamId,
    },
    production,
  });

  configured = true;
  logger.info(`[APNs] Initialized (production=${String(production)}, bundleId=${bundleId})`);
}

/**
 * Shutdown the APNs provider. Call during graceful server shutdown.
 *
 * Pending debounce timers are cleared. A pending update that hasn't fired by
 * shutdown is lost; the next queue event or heartbeat tick after the new
 * process boots will produce a fresh send.
 */
export async function shutdownApns(): Promise<void> {
  for (const [, entry] of pendingSends) {
    clearTimeout(entry.timeout);
  }
  pendingSends.clear();

  if (provider) {
    await provider.shutdown();
    provider = null;
    configured = false;
    logger.info('[APNs] Provider shut down');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getTokenRegistrationsForSession(sessionId: string): Promise<LiveActivityTokenRegistration[]> {
  const rows = await db
    .select({ token: activityPushTokens.token, userId: activityPushTokens.userId })
    .from(activityPushTokens)
    .where(eq(activityPushTokens.sessionId, sessionId));

  return rows.map((registration) => ({
    token: registration.token,
    userId: registration.userId ?? null,
  }));
}

async function deleteStaleToken(token: string): Promise<void> {
  try {
    await db.delete(activityPushTokens).where(eq(activityPushTokens.token, token));
    metrics.tokensRemovedOn410++;
    logger.info(`[APNs] Deleted stale token ${token.slice(0, 8)}...`);
  } catch (error) {
    logger.error('[APNs] Failed to delete stale token:', error);
  }
}

interface SendOptions {
  /** If set, used in the structured log line to indicate the trigger. */
  source?: SendSource;
}

function createDeliveryCounts(): DeliveryCounts {
  return {
    tokenCount: 0,
    sentCount: 0,
    failedCount: 0,
    staleCount: 0,
  };
}

function getDeliveryCountsForRegistration(
  registration: LiveActivityTokenRegistration,
  deliveryCountsByUserId: Map<string, DeliveryCounts>,
  unattributedDeliveryCounts: DeliveryCounts,
): DeliveryCounts {
  if (!registration.userId) return unattributedDeliveryCounts;

  const existingCounts = deliveryCountsByUserId.get(registration.userId);
  if (existingCounts) return existingCounts;

  const createdCounts = createDeliveryCounts();
  deliveryCountsByUserId.set(registration.userId, createdCounts);
  return createdCounts;
}

function trackPushDeliveryForRegistrations({
  sessionId,
  event,
  source,
  registrations,
  sentDevices,
  failedDevices,
  staleDevices,
  elapsedMs,
}: DeliveryTrackingInput): void {
  const registrationByToken = new Map(registrations.map((registration) => [registration.token, registration]));
  const deliveryCountsByUserId = new Map<string, DeliveryCounts>();
  const unattributedDeliveryCounts = createDeliveryCounts();

  for (const registration of registrations) {
    getDeliveryCountsForRegistration(registration, deliveryCountsByUserId, unattributedDeliveryCounts).tokenCount++;
  }

  for (const sentDevice of sentDevices) {
    const registration = registrationByToken.get(sentDevice);
    if (!registration) continue;
    getDeliveryCountsForRegistration(registration, deliveryCountsByUserId, unattributedDeliveryCounts).sentCount++;
  }

  for (const failedDevice of failedDevices) {
    const registration = registrationByToken.get(failedDevice);
    if (!registration) continue;
    const deliveryCounts = getDeliveryCountsForRegistration(
      registration,
      deliveryCountsByUserId,
      unattributedDeliveryCounts,
    );
    deliveryCounts.failedCount++;
    if (staleDevices.has(failedDevice)) {
      deliveryCounts.staleCount++;
    }
  }

  for (const [userId, deliveryCounts] of deliveryCountsByUserId.entries()) {
    trackLiveActivityPushDelivery({
      userId,
      sessionId,
      event,
      source,
      tokenCount: deliveryCounts.tokenCount,
      sentCount: deliveryCounts.sentCount,
      failedCount: deliveryCounts.failedCount,
      staleCount: deliveryCounts.staleCount,
      elapsedMs,
    });
  }

  if (unattributedDeliveryCounts.tokenCount > 0) {
    trackLiveActivityPushDeliveryAttributionGap({
      sessionId,
      event,
      source,
      reason: 'missing_user_id',
      tokenCount: unattributedDeliveryCounts.tokenCount,
      sentCount: unattributedDeliveryCounts.sentCount,
      failedCount: unattributedDeliveryCounts.failedCount,
      staleCount: unattributedDeliveryCounts.staleCount,
      elapsedMs,
    });
  }
}

async function sendNotification(
  sessionId: string,
  registrations: LiveActivityTokenRegistration[],
  event: 'update' | 'end',
  contentState?: LiveActivityContentState,
  options: SendOptions = {},
): Promise<{ sent: number; failed: number; stale: number }> {
  if (!provider || registrations.length === 0) return { sent: 0, failed: 0, stale: 0 };

  const tokens = registrations.map((registration) => registration.token);
  metrics.sendsAttempted += tokens.length;

  const notification = new apn.Notification();
  notification.topic = `${bundleId}.push-type.liveactivity`;
  notification.pushType = 'liveactivity';
  notification.priority = 10;

  notification.aps = {
    timestamp: Math.floor(Date.now() / 1000),
    event,
  };

  if (contentState && event === 'update') {
    notification.aps['content-state'] = contentState;
  }

  notification.expiry = Math.floor(Date.now() / 1000) + (event === 'end' ? 60 : 300);

  const startedAt = Date.now();
  let stale = 0;
  const staleDevices = new Set<string>();

  try {
    const result = await provider.send(notification, tokens);
    const sent = result.sent.length;
    const failed = result.failed.length;
    metrics.sendsSucceeded += sent;
    metrics.sendsFailed += failed;

    if (failed > 0) {
      const staleTokenDeletions: Promise<void>[] = [];

      for (const failure of result.failed) {
        const reason = failure.response?.reason;
        const status = failure.status;

        if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken') {
          stale++;
          staleDevices.add(failure.device);
          staleTokenDeletions.push(deleteStaleToken(failure.device));
        } else {
          logger.error(
            `[APNs] Send failed for session ${sessionId}, token ${failure.device.slice(0, 8)}...: ` +
              `status=${String(status)} reason=${reason ?? 'unknown'}`,
          );
        }
      }

      if (staleTokenDeletions.length > 0) {
        await Promise.all(staleTokenDeletions);
      }
    }

    logger.info(
      `[APNs] session=${sessionId} event=${event} source=${options.source ?? 'event'} ` +
        `tokens=${String(tokens.length)} sent=${String(sent)} failed=${String(failed)} stale=${String(stale)} ` +
        `elapsedMs=${String(Date.now() - startedAt)}`,
    );
    trackPushDeliveryForRegistrations({
      sessionId,
      event,
      source: options.source ?? 'event',
      registrations,
      sentDevices: result.sent.map((sentDevice) => sentDevice.device),
      failedDevices: result.failed.map((failedDevice) => failedDevice.device),
      staleDevices,
      elapsedMs: Date.now() - startedAt,
    });

    return { sent, failed, stale };
  } catch (error) {
    metrics.sendsFailed += tokens.length;
    logger.error(`[APNs] Send error for session ${sessionId}:`, error);
    trackPushDeliveryForRegistrations({
      sessionId,
      event,
      source: options.source ?? 'event',
      registrations,
      sentDevices: [],
      failedDevices: tokens,
      staleDevices: new Set<string>(),
      elapsedMs: Date.now() - startedAt,
    });
    return { sent: 0, failed: tokens.length, stale: 0 };
  }
}

/**
 * Resolve the session's board holder ONCE (the hot-path contract: one holder
 * lookup per send, never per token), then send the `update` push GROUPED by each
 * token's derived board-connection state.
 *
 * When the holder can't be resolved (no resolver wired, no board mapping, no
 * Redis, anonymous holder, or a lookup error) the whole set is sent as a single
 * group with boardConnection OMITTED — the prior behaviour, and the device then
 * falls back to its own App-Group state.
 *
 * When the holder IS known, registrations split into (typically ≤2) groups by
 * derived state — the holder's own device(s) get 'connectedByMe', everyone else
 * gets 'heldByPeer' (+ holderDisplayName). Each group is a separate
 * `sendNotification` call so the existing structured logging / analytics /
 * stale-token (410) handling keeps operating on the registrations it was given.
 */
async function sendGroupedNotification(
  sessionId: string,
  registrations: LiveActivityTokenRegistration[],
  baseContentState: LiveActivityContentState,
  options: SendOptions = {},
): Promise<void> {
  if (registrations.length === 0) return;

  let holder: BoardHolder | null = null;
  if (sessionHolderResolver) {
    try {
      holder = await sessionHolderResolver(sessionId);
    } catch (error) {
      // Tolerate a failing lookup: omit boardConnection and let the device fall
      // back to its own state. Debug-level — a missing holder is the common case
      // (no board paired yet), not an error worth surfacing at info/error.
      logger.debug(`[APNs] Holder lookup failed for session ${sessionId}; omitting boardConnection:`, error);
      holder = null;
    }
  }

  if (!holder) {
    await sendNotification(sessionId, registrations, 'update', baseContentState, options);
    return;
  }

  // Group registrations by their serialized per-token board-connection patch so
  // every distinct state is one send. In practice this is ≤2 groups
  // (connectedByMe for the holder's device(s), heldByPeer for the rest).
  const groups = new Map<
    string,
    { contentState: LiveActivityContentState; registrations: LiveActivityTokenRegistration[] }
  >();
  for (const registration of registrations) {
    const derived = deriveBoardConnection({
      tokenUserId: registration.userId,
      holderUserId: holder.holderUserId,
      holderDisplayName: holder.holderDisplayName,
    });
    const groupKey = `${derived.boardConnection}|${derived.holderDisplayName ?? ''}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        contentState: { ...baseContentState, ...derived },
        registrations: [],
      };
      groups.set(groupKey, group);
    }
    group.registrations.push(registration);
  }

  await Promise.all(
    [...groups.values()].map((group) =>
      sendNotification(sessionId, group.registrations, 'update', group.contentState, options),
    ),
  );
}

function trackSessionEndedForRegistrations(sessionId: string, registrations: LiveActivityTokenRegistration[]): void {
  const tokenCountsByUserId = new Map<string, number>();
  let unattributedTokenCount = 0;

  for (const registration of registrations) {
    if (!registration.userId) {
      unattributedTokenCount++;
      continue;
    }
    tokenCountsByUserId.set(registration.userId, (tokenCountsByUserId.get(registration.userId) ?? 0) + 1);
  }

  for (const [userId, tokenCount] of tokenCountsByUserId.entries()) {
    trackLiveActivityEnded({
      userId,
      sessionId,
      reason: 'session-ended',
      tokenCount,
    });
  }

  if (unattributedTokenCount > 0) {
    trackLiveActivityEndedAttributionGap({
      sessionId,
      reason: 'missing_user_id',
      tokenCount: unattributedTokenCount,
    });
  }
}

/**
 * Execute debounced send: looks up tokens and delivers the notification.
 *
 * On transient DB failure, re-arms the debounce timer with an exponential
 * backoff schedule. The pendingSends entry is preserved across the retry so
 * the latest coalesced state is still sent when the DB recovers.
 *
 * On retry exhaustion, requeue the latest state with a fresh retry counter so
 * a transient outage doesn't permanently drop the update — the next attempt
 * starts at debounce 0 with the same `latestState` (which may have been
 * mutated by intervening `sendLiveActivityUpdate` calls).
 */
async function executeDebouncedSend(sessionId: string): Promise<void> {
  const entry = pendingSends.get(sessionId);
  if (!entry) return;

  let registrations: LiveActivityTokenRegistration[];
  try {
    registrations = await getTokenRegistrationsForSession(sessionId);
  } catch (error) {
    if (entry.dbRetryAttempt < DB_RETRY_DELAYS_MS.length) {
      const delay = DB_RETRY_DELAYS_MS[entry.dbRetryAttempt];
      logger.error(
        `[APNs] getTokenRegistrationsForSession failed for session ${sessionId} ` +
          `(retry ${String(entry.dbRetryAttempt + 1)}/${String(DB_RETRY_DELAYS_MS.length)} in ${String(delay)}ms):`,
        error,
      );
      entry.dbRetryAttempt++;
      metrics.dbRetriesUsed++;
      entry.timeout = setTimeout(() => {
        executeDebouncedSend(sessionId).catch((retryError) => {
          logger.error(`[APNs] Retried debounced send failed for session ${sessionId}:`, retryError);
        });
      }, delay);
      return;
    }
    logger.error(
      `[APNs] Giving up on session ${sessionId} after ${String(DB_RETRY_DELAYS_MS.length)} DB retry(ies):`,
      error,
    );
    const lastState = entry.latestState;
    const lastSource = entry.source;
    pendingSends.delete(sessionId);
    // Requeue with a fresh retry counter so the user-visible regression is
    // bounded by one more debounce window rather than 90 s of heartbeat lag.
    // Synchronous delete + synchronous sendLiveActivityUpdate run on the same
    // event-loop task — Node.js single-threading means no foreign callback
    // can interleave between these two lines.
    sendLiveActivityUpdate(sessionId, lastState, { source: lastSource });
    return;
  }

  const source = entry.source;
  pendingSends.delete(sessionId);
  if (registrations.length === 0) {
    // Demoted to debug because every queue event on a party session without an
    // iOS Live Activity device produces one of these. Multiplied by N backend
    // instances and M queue events/min, the info-level version was unreadable.
    logger.debug(`[APNs] No registered Live Activity tokens for session ${sessionId}; skipping update`);
    return;
  }

  await sendGroupedNotification(sessionId, registrations, entry.latestState, { source });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a debounced Live Activity update for a session.
 *
 * If called multiple times within the debounce window, only the latest state
 * is sent. This respects APNs rate limits for Live Activity updates while
 * still feeling responsive for back-to-back queue mutations.
 *
 * `options.source` flows into the structured per-send log line so heartbeat
 * sends, queue events, and registration kicks are distinguishable in logs.
 * Latest call wins on coalesce.
 */
export function sendLiveActivityUpdate(
  sessionId: string,
  contentState: LiveActivityContentState,
  options: { source?: SendSource } = {},
): void {
  if (!configured) return;

  const source = options.source ?? 'event';
  const existing = pendingSends.get(sessionId);

  if (existing) {
    existing.latestState = contentState;
    existing.source = source;
    metrics.sendsCoalesced++;
    return;
  }

  const timeout = setTimeout(() => {
    executeDebouncedSend(sessionId).catch((error) => {
      logger.error(`[APNs] Debounced send failed for session ${sessionId}:`, error);
    });
  }, DEBOUNCE_MS);

  pendingSends.set(sessionId, { timeout, latestState: contentState, dbRetryAttempt: 0, source });
}

/**
 * Send an immediate Live Activity update to a specific set of token registrations,
 * bypassing the per-session debounce. Used right after a device registers a
 * push token so the lock-screen widget exits "Loading…" without waiting for
 * the next organic queue event.
 *
 * Failures are logged but never thrown — this is a best-effort optimisation,
 * not a correctness guarantee.
 */
export async function sendLiveActivityUpdateToTokens(
  sessionId: string,
  registrations: LiveActivityTokenRegistration[],
  contentState: LiveActivityContentState,
  options: { source?: 'registration' | 'heartbeat' } = {},
): Promise<void> {
  if (!configured) return;
  if (registrations.length === 0) return;
  await sendGroupedNotification(sessionId, registrations, contentState, {
    source: options.source ?? 'registration',
  });
}

/**
 * End all Live Activities for a session.
 * Sends an "end" event to dismiss the activity on all devices and
 * cleans up tokens from the database.
 */
export async function endLiveActivity(sessionId: string): Promise<void> {
  if (!configured) return;

  const pending = pendingSends.get(sessionId);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingSends.delete(sessionId);
  }

  let registrations: LiveActivityTokenRegistration[] = [];
  try {
    registrations = await getTokenRegistrationsForSession(sessionId);
  } catch (error) {
    logger.error(`[APNs] endLiveActivity: token lookup failed for session ${sessionId}:`, error);
  }
  if (registrations.length > 0) {
    await sendNotification(sessionId, registrations, 'end');
    trackSessionEndedForRegistrations(sessionId, registrations);
  } else {
    logger.debug(`[APNs] No registered Live Activity tokens for session ${sessionId}; skipping end`);
  }

  await cleanupTokensForSession(sessionId);
}

export async function cleanupTokensForSession(sessionId: string): Promise<void> {
  try {
    await db.delete(activityPushTokens).where(eq(activityPushTokens.sessionId, sessionId));
    logger.info(`[APNs] Cleaned up tokens for session ${sessionId}`);
  } catch (error) {
    logger.error(`[APNs] Failed to clean up tokens for session ${sessionId}:`, error);
  }
}

/** Internal helper for `__resetApnsForTests`: clears pendingSends timers and resets counters. */
function __resetApnsStateForTests(): void {
  for (const [, entry] of pendingSends) {
    clearTimeout(entry.timeout);
  }
  pendingSends.clear();
  for (const key of Object.keys(metrics) as (keyof ApnsMetrics)[]) {
    metrics[key] = 0;
  }
}

/**
 * Test-only utility for fully clearing module state between tests. Matches
 * the `__reset*ForTests` pattern used by widget-navigate and push-tokens.
 * Strictly stronger than `__resetApnsStateForTests`: also nulls the provider,
 * clears bundleId/configured, and restores DEBOUNCE_MS / DB_RETRY_DELAYS_MS
 * to their production defaults. Tests that call `initializeApns()` should
 * use this so the next test starts on a clean slate.
 */
export function __resetApnsForTests(): void {
  __resetApnsStateForTests();
  provider = null;
  bundleId = '';
  configured = false;
  sessionHolderResolver = null;
  DEBOUNCE_MS = DEFAULT_DEBOUNCE_MS;
  DB_RETRY_DELAYS_MS = DEFAULT_DB_RETRY_DELAYS_MS;
}

/**
 * Test-only override for the debounce and DB-retry windows. Used by
 * `apns.test.ts` to collapse the 1 s debounce + multi-second retry delays
 * into a few ms so we don't have to combine fake timers with the real
 * postgres-js pool (the pool's own setTimeout-based idle/keepalive logic
 * deadlocks under faked timers). Reset by `__resetApnsForTests`.
 */
export function __setApnsTimingForTests(opts: { debounceMs?: number; dbRetryDelaysMs?: readonly number[] }): void {
  if (opts.debounceMs !== undefined) DEBOUNCE_MS = opts.debounceMs;
  if (opts.dbRetryDelaysMs !== undefined) DB_RETRY_DELAYS_MS = opts.dbRetryDelaysMs;
}
