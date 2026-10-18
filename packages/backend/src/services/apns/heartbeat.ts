/**
 * APNs Live Activity heartbeat.
 *
 * Backgrounded iOS apps lose the native WebSocket, so the only way to keep the
 * lock-screen Live Activity from going stale (`staleDate = now + 10min` on the
 * device) is for the server to push an APNs update. Real queue events do that
 * naturally, but when a session is idle for several minutes the activity would
 * tip over into "Session ended" before any new event arrives.
 *
 * This module runs a periodic sweep every 90 s that re-sends the current
 * content state for every session with at least one registered push token.
 *
 * Multi-instance safety: each tick acquires a cluster-wide Redis lock so that
 * only one instance in the cluster does the sweep on any given tick. Without
 * the lock, N instances would each push N times for every session, eating
 * into APNs' per-activity rate budget. Same pattern as
 * `refreshPopularConfigsCache` in services/popular-board-configs.ts.
 */

import { activityPushTokens } from '@boardsesh/db/schema/app';
import { db } from '../../db/client';
import { redisClientManager } from '../../redis/client';
import {
  type LiveActivityContentState,
  hasPendingSend,
  incrementApnsMetric,
  isApnsConfigured,
  sendLiveActivityUpdate,
} from './index';
import { buildContentStateFromQueueState } from './content-state';
import type { QueueState } from '../room-manager';
import { logger } from '../../utils/logger';

const HEARTBEAT_INTERVAL_MS = 90 * 1000;

// Lock TTL is twice the tick interval so a slow/crashing leader doesn't lock
// the cluster out indefinitely.
const HEARTBEAT_LOCK_KEY = 'boardsesh:apns:heartbeat-lock';
const HEARTBEAT_LOCK_TTL_SEC = 180;

// Process at most this many sessions in parallel per tick so a slow Redis or
// roomManager doesn't serialize the whole sweep.
const HEARTBEAT_CONCURRENCY = 10;

let heartbeatHandle: ReturnType<typeof setInterval> | null = null;

interface RoomManagerLike {
  getQueueState(sessionId: string): Promise<QueueState>;
}

async function getSessionsWithRegisteredTokens(): Promise<string[]> {
  const rows = await db.selectDistinct({ sessionId: activityPushTokens.sessionId }).from(activityPushTokens);
  return rows.map((r) => r.sessionId);
}

async function buildHeartbeatStateFor(
  sessionId: string,
  roomManager: RoomManagerLike,
): Promise<LiveActivityContentState | null> {
  const queueState = await roomManager.getQueueState(sessionId);
  return buildContentStateFromQueueState(queueState);
}

/**
 * Try to acquire the cluster-wide heartbeat lock. Returns true if this
 * instance won. If Redis isn't connected, returns true so single-instance dev
 * still works — the lock is purely a multi-instance dedupe, not a correctness
 * primitive.
 */
async function acquireHeartbeatLock(instanceId: string): Promise<boolean> {
  if (!redisClientManager.isRedisConnected()) return true;
  try {
    const { publisher } = redisClientManager.getClients();
    const result = await publisher.set(HEARTBEAT_LOCK_KEY, instanceId, 'EX', HEARTBEAT_LOCK_TTL_SEC, 'NX');
    return result === 'OK';
  } catch (error) {
    logger.warn('[APNs Heartbeat] Failed to acquire lock; skipping tick:', error);
    return false;
  }
}

/**
 * Run `worker` against each item in `items` with at most `limit` items in
 * flight at once. Relies on Node.js single-threading: the `const index =
 * cursor++` claim happens synchronously and is the only mutation point — no
 * `await` falls between the read and the increment, so two workers cannot
 * claim the same index. Don't insert an await above the increment.
 */
async function processWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function nextBatch(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => nextBatch()));
}

async function runHeartbeatTick(roomManager: RoomManagerLike, instanceId: string): Promise<void> {
  if (!isApnsConfigured()) return;

  if (!(await acquireHeartbeatLock(instanceId))) return;

  let sessions: string[];
  try {
    sessions = await getSessionsWithRegisteredTokens();
  } catch (error) {
    logger.error('[APNs Heartbeat] Failed to list sessions with registered tokens:', error);
    return;
  }

  if (sessions.length === 0) return;

  await processWithConcurrency(sessions, HEARTBEAT_CONCURRENCY, async (sessionId) => {
    // Skip sessions where a real queue event already has a debounce timer in
    // flight — the heartbeat is a backstop, not a primary update path.
    if (hasPendingSend(sessionId)) return;
    try {
      const state = await buildHeartbeatStateFor(sessionId, roomManager);
      if (!state) return;
      // Pass source so the structured per-send log line attributes the push to
      // the heartbeat, not a real queue event.
      sendLiveActivityUpdate(sessionId, state, { source: 'heartbeat' });
      incrementApnsMetric('heartbeatsSent');
    } catch (error) {
      logger.warn(`[APNs Heartbeat] Failed to build heartbeat state for session ${sessionId}:`, error);
    }
  });
}

/**
 * Start the periodic heartbeat loop. Safe to call multiple times; subsequent
 * calls are no-ops until `stopApnsHeartbeat()` is called.
 */
export function startApnsHeartbeat(roomManager: RoomManagerLike, instanceId: string): void {
  if (heartbeatHandle !== null) return;
  if (!isApnsConfigured()) return;

  logger.info(`[APNs Heartbeat] Started (interval=${String(HEARTBEAT_INTERVAL_MS)}ms, instance=${instanceId})`);

  heartbeatHandle = setInterval(() => {
    runHeartbeatTick(roomManager, instanceId).catch((error) => {
      logger.error('[APNs Heartbeat] Tick failed:', error);
    });
  }, HEARTBEAT_INTERVAL_MS);

  if (typeof heartbeatHandle.unref === 'function') heartbeatHandle.unref();
}

export function stopApnsHeartbeat(): void {
  if (heartbeatHandle === null) return;
  clearInterval(heartbeatHandle);
  heartbeatHandle = null;
  logger.info('[APNs Heartbeat] Stopped');
}

/** Test-only utility. */
export async function __runHeartbeatTickForTests(roomManager: RoomManagerLike, instanceId = 'test'): Promise<void> {
  await runHeartbeatTick(roomManager, instanceId);
}
