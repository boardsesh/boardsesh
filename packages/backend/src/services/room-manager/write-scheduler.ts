import type { ClimbQueueItem, UserPick } from '@boardsesh/shared-schema';
import { db } from '../../db/client';
import { sessions, sessionQueues } from '../../db/schema';
import { eq } from 'drizzle-orm';
import type { DistributedStateManager } from '../distributed-state';
import { isForeignKeyViolation, type PendingWrite } from './types';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 1000; // 1 second

/**
 * Manages debounced Postgres writes, retries, and pending write state.
 * Redis is the source of truth for active sessions; Postgres writes are
 * eventually consistent via this scheduler.
 */
export class WriteScheduler {
  private postgresWriteTimers = new Map<string, NodeJS.Timeout>();
  private pendingWrites = new Map<string, PendingWrite>();
  private writeRetryAttempts = new Map<string, number>();
  private retryTimers = new Map<string, NodeJS.Timeout>();

  reset(): void {
    for (const timer of this.postgresWriteTimers.values()) {
      clearTimeout(timer);
    }
    this.postgresWriteTimers.clear();
    this.pendingWrites.clear();
    this.writeRetryAttempts.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  /**
   * Cancel all pending writes for a session (debounced and retry timers).
   * Used when a session ends or becomes empty to prevent FK violations.
   */
  cancelPendingWrites(sessionId: string): void {
    const timer = this.postgresWriteTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.postgresWriteTimers.delete(sessionId);
    }
    const retryTimer = this.retryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.retryTimers.delete(sessionId);
    }
    this.pendingWrites.delete(sessionId);
    this.writeRetryAttempts.delete(sessionId);
  }

  /**
   * Schedule a debounced write to Postgres for queue state (30 seconds).
   * Writes to Redis happen immediately, Postgres writes are batched.
   */
  schedulePostgresWrite(
    sessionId: string,
    queue: ClimbQueueItem[],
    currentClimbQueueItem: ClimbQueueItem | null,
    picks: UserPick[],
    activeClimberUserId: string | null,
    version: number,
    sequence: number,
    distributedState: DistributedStateManager | null,
  ): void {
    // Refresh session membership TTL on activity to prevent expiry during long sessions
    if (distributedState) {
      distributedState.refreshSessionMembership(sessionId).catch((err) => {
        console.warn(`[RoomManager] Failed to refresh session TTL for ${sessionId}:`, err);
      });
    }

    // Store latest state
    this.pendingWrites.set(sessionId, { queue, currentClimbQueueItem, picks, activeClimberUserId, version, sequence });

    // Clear existing timer
    const existingTimer = this.postgresWriteTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule write in 30 seconds
    const timer = setTimeout(async () => {
      const state = this.pendingWrites.get(sessionId);
      if (state) {
        try {
          await writeQueueStateToPostgres(sessionId, state, this);
          this.pendingWrites.delete(sessionId);
          this.postgresWriteTimers.delete(sessionId);
          console.info(`[RoomManager] Debounced Postgres write completed for session ${sessionId}`);
        } catch (error) {
          console.error(`[RoomManager] Debounced Postgres write failed for session ${sessionId}:`, error);
          // Retry with exponential backoff instead of giving up
          await this.retryPostgresWrite(sessionId, state, error);
        }
      }
    }, 30000); // 30 seconds

    this.postgresWriteTimers.set(sessionId, timer);
  }

  /**
   * Calculate exponential backoff delay for retry attempts.
   */
  private calculateRetryDelay(attempt: number): number {
    return Math.min(
      RETRY_BASE_DELAY * Math.pow(2, attempt),
      30000, // Max 30 seconds
    );
  }

  /**
   * Retry a failed Postgres write with exponential backoff.
   */
  private async retryPostgresWrite(
    sessionId: string,
    state: {
      queue: ClimbQueueItem[];
      currentClimbQueueItem: ClimbQueueItem | null;
      picks: UserPick[];
      activeClimberUserId: string | null;
      version: number;
      sequence: number;
    },
    lastError?: unknown,
  ): Promise<void> {
    // Don't retry FK violations - session doesn't exist, retries will never succeed
    if (lastError && isForeignKeyViolation(lastError)) {
      console.warn(`[RoomManager] Not retrying write for session ${sessionId} - session doesn't exist in Postgres`);
      this.cancelPendingWrites(sessionId);
      return;
    }

    const attempts = this.writeRetryAttempts.get(sessionId) || 0;

    if (attempts >= MAX_RETRY_ATTEMPTS) {
      console.error(
        `[RoomManager] Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for session ${sessionId}. ` +
          `Data may be lost. Last state:`,
        { queueLength: state.queue.length, version: state.version },
      );
      this.pendingWrites.delete(sessionId);
      this.writeRetryAttempts.delete(sessionId);
      this.retryTimers.delete(sessionId);
      return;
    }

    this.writeRetryAttempts.set(sessionId, attempts + 1);
    const delay = this.calculateRetryDelay(attempts);

    console.info(
      `[RoomManager] Scheduling retry ${attempts + 1}/${MAX_RETRY_ATTEMPTS} ` +
        `for session ${sessionId} in ${delay}ms`,
    );

    // Clear any existing retry timer for this session
    const existingTimer = this.retryTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      // Clean up timer reference when it executes
      this.retryTimers.delete(sessionId);

      const currentState = this.pendingWrites.get(sessionId);
      if (currentState) {
        try {
          await writeQueueStateToPostgres(sessionId, currentState, this);
          this.pendingWrites.delete(sessionId);
          this.writeRetryAttempts.delete(sessionId);
          console.info(`[RoomManager] Retry successful for session ${sessionId}`);
        } catch (error) {
          console.error(`[RoomManager] Retry ${attempts + 1} failed for session ${sessionId}:`, error);
          await this.retryPostgresWrite(sessionId, currentState, error);
        }
      }
    }, delay);

    this.retryTimers.set(sessionId, timer);
  }

  /**
   * Flush all pending debounced writes to Postgres immediately.
   * Called on graceful shutdown to ensure durability.
   */
  async flushPendingWrites(sessionGraceTimers: Map<string, NodeJS.Timeout>): Promise<void> {
    console.info(`[RoomManager] Flushing ${this.pendingWrites.size} pending writes to Postgres...`);

    const writePromises: Promise<void>[] = [];

    for (const [sessionId, state] of this.pendingWrites.entries()) {
      // Clear the debounce timer
      const timer = this.postgresWriteTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.postgresWriteTimers.delete(sessionId);
      }

      // Write immediately
      writePromises.push(
        writeQueueStateToPostgres(sessionId, state, this).catch((error) => {
          console.error(`[RoomManager] Failed to flush write for session ${sessionId}:`, error);
        }),
      );
    }

    await Promise.all(writePromises);
    this.pendingWrites.clear();

    // Clear retry state to prevent memory leaks from abandoned sessions
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.writeRetryAttempts.clear();

    // Clear grace timers
    for (const timer of sessionGraceTimers.values()) {
      clearTimeout(timer);
    }
    sessionGraceTimers.clear();

    console.info('[RoomManager] All pending writes flushed');
  }
}

/**
 * Write queue state directly to Postgres (used by debouncer).
 */
export async function writeQueueStateToPostgres(
  sessionId: string,
  state: PendingWrite,
  scheduler: WriteScheduler,
): Promise<void> {
  // Check if session exists to prevent FK violation
  const sessionExists = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);

  if (sessionExists.length === 0) {
    console.warn(
      `[RoomManager] Skipping queue write for session ${sessionId} - session not in Postgres. ` +
        `Queue had ${state.queue.length} items.`,
    );
    scheduler.cancelPendingWrites(sessionId);
    return;
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .insert(sessionQueues)
      .values({
        sessionId,
        queue: state.queue,
        currentClimbQueueItem: state.currentClimbQueueItem,
        picks: state.picks,
        activeClimberUserId: state.activeClimberUserId,
        version: state.version,
        sequence: state.sequence,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sessionQueues.sessionId,
        set: {
          queue: state.queue,
          currentClimbQueueItem: state.currentClimbQueueItem,
          picks: state.picks,
          activeClimberUserId: state.activeClimberUserId,
          version: state.version,
          sequence: state.sequence,
          updatedAt: now,
        },
      });

    await tx.update(sessions).set({ lastActivity: now }).where(eq(sessions.id, sessionId));
  });
}
