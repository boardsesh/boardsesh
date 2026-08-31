import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, ne, and, or, isNotNull, sql } from 'drizzle-orm';

import { auroraCredentials } from '@boardsesh/db/schema/auth';
import {
  AURORA_SYNC_DAEMON,
  SHARED_SYNC_COOLDOWN_CURSOR,
  acquireOrRenewDaemonLease,
  claimNextCredentialForSync,
  claimSharedSyncSlot,
  credentialBackoffMs,
  findGymsDueForWallCrawl,
  getCredentialFleetSnapshot,
  readSharedSyncCursor,
  releaseDaemonLease,
  selfHealStaleClimbStats,
  stampSharedSyncFinished,
  type SharedSyncClaimToken,
} from '@boardsesh/db/queries';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import { syncUserData, hasForeignOwnedCircuitPlaylists } from '../sync/user-sync';
import { syncSharedData } from '../sync/shared-sync';
import { createAuroraGymUserFetcher, createAuroraGymUserFetcherForToken } from '../sync/gym-wall-fetcher';
import {
  AURORA_LOCATION_BOARDS,
  crawlGymWallsForSourceKeys,
  GYM_WALL_CRAWL_SLICE,
  syncAllAuroraBoardLocations,
  syncAuroraBoardLocations,
  type AuroraLocationBoardName,
} from '../sync/locations-sync';
import { AuroraClimbingClient } from '../api/aurora-client';
import { isAuroraRequestError, isTransientAuroraError, isTransientSharedSyncAuroraError } from '../api/errors';
import { decrypt, encrypt } from '@boardsesh/crypto';
import type { LocationSyncSummary } from '@boardsesh/location-sync';
import type { AuroraBoardName } from '../api/types';
import {
  DaemonLease,
  formatSyncHealthSummary as formatSharedSyncHealthSummary,
  resolveDaemonOptions,
  runDaemonLoop,
  type SyncHealthSnapshot,
} from '@boardsesh/sync-runtime';
import type { SyncRunnerConfig, SyncSummary, CredentialRecord, DaemonOptions, SyncErrorContext } from './types';

type RunnerClient = ReturnType<typeof postgres>;
type RunnerDb = ReturnType<typeof drizzle>;

// Cooldown between shared-sync attempts on the same board, regardless of which
// user-sync triggered them. Without this, if N users on the same board cycle
// in quick succession, we'd fire N independent shared-sync loops against
// Aurora and N independent setter-notification scans — all redundant, since
// the per-table cursors mean only the first one would actually find new rows.
// 1 hour matches the smallest unit of meaningful change for board-wide data
// (climbs, climb_stats); tune via SyncRunnerConfig.sharedSyncCooldownMs.
const DEFAULT_SHARED_SYNC_COOLDOWN_MS = 60 * 60 * 1000;
const TRANSIENT_SHARED_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_FAILURES = 2;

/**
 * Resolve the cooldown to apply after a failed shared sync. Only the narrow
 * canonical Aurora failures classified as retryable get the five-minute path;
 * every other throw keeps the configured full cooldown. The retry is clamped
 * to the full cooldown so a test/local configuration below five minutes is
 * never lengthened by failure handling.
 */
export function sharedSyncCooldownAfterError(error: unknown, configuredCooldownMs: number): number {
  const fullCooldownMs = Math.max(0, configuredCooldownMs);
  return isTransientSharedSyncAuroraError(error)
    ? Math.min(TRANSIENT_SHARED_SYNC_COOLDOWN_MS, fullCooldownMs)
    : fullCooldownMs;
}

// aurora-sync owns every board EXCEPT kilter (which kilter-sync drives via its
// own OAuth flow), so every credential query here excludes this board_type.
// Named once so the scheduler filter and the health snapshot can't drift.
const KILTER_BOARD_TYPE = 'kilter';

// Consecutive-failure count at which we emit a distinct FLAPPING log event.
// The credential is already backing off and rotating out (the starvation fix);
// this just makes "this one isn't a one-off blip" greppable for an operator.
// At 5 consecutive failures the backoff has accumulated ~2+4+8+16 = 30 min of
// skipped windows — a clear signal, and it fires exactly once (at the crossing)
// because consecutive_failures increments by 1 per cycle.
const CREDENTIAL_FLAP_THRESHOLD = 5;

// Hourly gate for the read-only fleet health summary logged by the daemon.
const SYNC_HEALTH_SUMMARY_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Failure carrying the credential's *resolved* post-attempt state so the
 * `syncNextUser` catch can build an accurate {@link SyncErrorContext} without a
 * re-read. Thrown by the deterministic-failure branches of
 * syncSingleCredential (decryption, invalid-credential, other login error).
 * Transient failures re-throw the original AuroraRequestError untouched (they
 * do NOT change sync_status), and DB errors surface as plain Errors — both fall
 * back to the credential's pre-attempt state in the catch, which is correct.
 */
export class CredentialSyncError extends Error {
  readonly syncStatus: string;
  readonly quarantined: boolean;

  constructor(message: string, options: { syncStatus: string; quarantined: boolean }) {
    super(message);
    this.name = 'CredentialSyncError';
    this.syncStatus = options.syncStatus;
    this.quarantined = options.quarantined;
  }
}

// Re-exported so this module's surface is unchanged by the move into
// @boardsesh/sync-runtime.
export type { SyncHealthSnapshot };

/**
 * Format the aurora fleet summary. Thin wrapper over the shared formatter in
 * @boardsesh/sync-runtime so aurora and kilter emit the same line shape and one
 * log alert covers both daemons.
 */
export function formatSyncHealthSummary(snapshot: SyncHealthSnapshot): string {
  return formatSharedSyncHealthSummary(snapshot, '[SyncRunner]', 'aurora credentials');
}

type CredentialFailureUpdate = {
  credentialFailureCount?: number;
  lastCredentialFailureAt?: Date | null;
  // Scheduler/observability fields (distinct from the invalid-credential
  // counter above): the attempt clock, the general consecutive-failure count
  // that drives backoff, and the last error message. Set on the success path
  // to reset them; failures stamp them via recordSyncFailure().
  lastSyncAttemptAt?: Date;
  consecutiveFailures?: number;
  lastSyncError?: string | null;
};

export class SyncRunner {
  private config: SyncRunnerConfig;
  private daemonController: AbortController | null = null;
  private client: RunnerClient | null = null;
  private db: RunnerDb | null = null;
  private lease: DaemonLease | null = null;
  // Per-process identity for the daemon lease. Minted once per SyncRunner so a
  // renewal is recognised as "still us" rather than a takeover.
  private readonly leaseHolderId = randomUUID();
  // In-memory hourly gate for the recompute self-heal. Resets to 0 on process
  // start, so the FIRST daemon cycle after a deploy runs the self-heal
  // immediately — exactly catching the debounced recomputes that the deploy's
  // restart dropped (the whole point of the self-heal).
  private lastSelfHealAt = 0;
  // In-memory hourly gate for the fleet health summary. Resets to 0 on process
  // start so the first daemon cycle after a deploy logs a snapshot immediately.
  private lastHealthSummaryAt = 0;

  constructor(config: SyncRunnerConfig = {}) {
    this.config = config;
  }

  private getSharedSyncCooldownMs(): number {
    return Math.max(0, this.config.sharedSyncCooldownMs ?? DEFAULT_SHARED_SYNC_COOLDOWN_MS);
  }

  private getClient(): { client: RunnerClient; db: RunnerDb } {
    if (!this.client || !this.db) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is required');
      }
      // `prepare: false` is required for Railway's PgBouncer pooled URL
      // (transaction-pooling mode is incompatible with prepared statements).
      this.client = postgres(connectionString, {
        max: 5,
        idle_timeout: 30,
        connect_timeout: 30,
        prepare: false,
      });
      this.db = drizzle(this.client);
    }
    return { client: this.client, db: this.db };
  }

  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(message);
    } else {
      console.info(message);
    }
  }

  private handleError(error: Error, context: SyncErrorContext): void {
    if (this.config.onError) {
      this.config.onError(error, context);
    } else {
      console.error(`[SyncRunner] Error:`, error, context);
    }
  }

  async syncNextUser(): Promise<SyncSummary> {
    const results: SyncSummary = {
      total: 1,
      successful: 0,
      failed: 0,
      errors: [],
    };

    const cred = await this.getNextCredentialToSync();

    if (!cred) {
      this.log(`[SyncRunner] No users with Aurora credentials to sync`);
      results.total = 0;
      return results;
    }

    this.log(`[SyncRunner] Syncing next user: ${cred.userId} for ${cred.boardType}`);

    try {
      await this.syncSingleCredential(cred);
      results.successful++;
      this.log(`[SyncRunner] ✓ Successfully synced user ${cred.userId} for ${cred.boardType}`);
    } catch (error) {
      results.failed++;
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      // Stamp the scheduler + observability fields on EVERY failure, whatever
      // path inside syncSingleCredential threw (transient login, invalid
      // credential, decryption). syncSingleCredential's own error branches set
      // the user-facing sync_status/sync_error where appropriate; this always
      // advances last_sync_attempt_at (so the credential rotates out of the
      // front of the queue instead of being re-picked first every cycle),
      // bumps consecutive_failures (backoff), and records last_sync_error.
      // Without this the transient-login path advanced NOTHING and wedged the
      // whole board's sync — the aurora starvation bug.
      await this.recordSyncFailure(cred, errorMsg);
      results.errors.push({
        userId: cred.userId,
        boardType: cred.boardType,
        error: errorMsg,
      });
      this.handleError(error instanceof Error ? error : new Error(errorMsg), this.buildErrorContext(cred, error));
      this.log(`[SyncRunner] ✗ Failed to sync user ${cred.userId} for ${cred.boardType}: ${errorMsg}`);
    }

    return results;
  }

  /**
   * Build the failure ledger snapshot handed to `onError`. `consecutiveFailures`
   * is the post-attempt count (recordSyncFailure just bumped it by one). The
   * resolved `syncStatus`/`quarantined` come from the CredentialSyncError thrown
   * by a deterministic-failure branch; a transient or DB error carries neither,
   * so we honestly fall back to the credential's pre-attempt status (unchanged
   * for transient) with `quarantined: false`.
   */
  private buildErrorContext(cred: CredentialRecord, error: unknown): SyncErrorContext {
    const resolved = error instanceof CredentialSyncError ? error : null;
    return {
      userId: cred.userId,
      board: cred.boardType,
      boardType: cred.boardType,
      syncStatus: resolved?.syncStatus ?? cred.syncStatus ?? undefined,
      consecutiveFailures: (cred.consecutiveFailures ?? 0) + 1,
      quarantined: resolved?.quarantined ?? false,
    };
  }

  /**
   * Record a failed sync attempt on the credential's scheduler fields. Runs on
   * every user-sync failure regardless of which inner branch threw. Touches
   * ONLY the attempt clock, the consecutive-failure counter (backoff), and the
   * observability error — NOT sync_status/sync_error, which the specific error
   * branches own (a transient failure must not flip the card to 'error'). The
   * counter is incremented in SQL so it is correct even if two paths update the
   * row in one cycle (e.g. recordInvalidCredentialFailure + this).
   */
  private async recordSyncFailure(cred: CredentialRecord, errorMsg: string): Promise<void> {
    const { db } = this.getClient();
    const attemptAt = new Date();
    await db
      .update(auroraCredentials)
      .set({
        lastSyncAttemptAt: attemptAt,
        consecutiveFailures: sql`COALESCE(${auroraCredentials.consecutiveFailures}, 0) + 1`,
        lastSyncError: errorMsg,
        updatedAt: attemptAt,
      })
      .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, cred.boardType)));

    // consecutive_failures is incremented in SQL above; mirror the resulting
    // value in JS to fire the FLAPPING event exactly once, when the streak
    // crosses the threshold (it grows by 1 per cycle, so `===` fires once).
    // Under two overlapping daemon instances (#3539, out of scope here) both
    // could read the same pre-increment value and each emit the event once —
    // a harmless duplicate log line, not a correctness issue.
    const consecutiveFailures = (cred.consecutiveFailures ?? 0) + 1;
    if (consecutiveFailures === CREDENTIAL_FLAP_THRESHOLD) {
      const nextRetryMs = credentialBackoffMs(consecutiveFailures);
      this.log(
        `[SyncRunner] ✗ CREDENTIAL FLAPPING user=${cred.userId} board=${cred.boardType} ` +
          `consecutiveFailures=${consecutiveFailures} nextRetryMs=${nextRetryMs} lastError=${errorMsg}`,
      );
    }
  }

  /** @deprecated Use syncNextUser() instead to avoid IP blocking */
  async syncAllUsers(): Promise<SyncSummary> {
    const results: SyncSummary = {
      total: 0,
      successful: 0,
      failed: 0,
      errors: [],
    };

    const credentials = await this.getActiveCredentials();
    results.total = credentials.length;

    this.log(`[SyncRunner] Found ${credentials.length} users with Aurora credentials to sync`);

    for (const cred of credentials) {
      try {
        await this.syncSingleCredential(cred);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        results.successful++;
        this.log(`[SyncRunner] ✓ Successfully synced user ${cred.userId} for ${cred.boardType}`);
      } catch (error) {
        results.failed++;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        // Stamp the scheduler + observability fields on every failure here too,
        // exactly as syncNextUser does. This CLI `all` path is deprecated in
        // favour of syncNextUser, but it's still wired to the `aurora-sync all`
        // command — without this it would advance neither the attempt clock nor
        // consecutive_failures, so an operator run would leave the backoff /
        // attempt-clock invisible for every credential it touched.
        await this.recordSyncFailure(cred, errorMsg);
        results.errors.push({
          userId: cred.userId,
          boardType: cred.boardType,
          error: errorMsg,
        });
        this.handleError(error instanceof Error ? error : new Error(errorMsg), {
          userId: cred.userId,
          board: cred.boardType,
        });
        this.log(`[SyncRunner] ✗ Failed to sync user ${cred.userId} for ${cred.boardType}: ${errorMsg}`);
      }
    }

    return results;
  }

  async syncUser(userId: string, boardType: string): Promise<void> {
    const { db } = this.getClient();
    const credentials = await db
      .select()
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)))
      .limit(1);

    if (credentials.length === 0) {
      throw new Error(`No credentials found for user ${userId} on ${boardType}`);
    }

    const cred = credentials[0] as CredentialRecord;
    await this.syncSingleCredential(cred);
  }

  async runDaemon(options: DaemonOptions = {}): Promise<void> {
    if (this.daemonController && !this.daemonController.signal.aborted) {
      throw new Error('Daemon mode is already running');
    }

    const resolved = resolveDaemonOptions(options);
    const controller = new AbortController();
    this.daemonController = controller;
    const lease = this.getLease();

    this.log(
      `[SyncRunner] Starting daemon mode (${resolved.timeZone}, quiet ${resolved.quietHoursStart}:00-${resolved.quietHoursEnd}:00, random interval ${resolved.minDelayMinutes}-${resolved.maxDelayMinutes} minutes)`,
    );

    try {
      await runDaemonLoop(
        async () => {
          await this.syncNextUser();
          // Checkpoint between units of work: if a heartbeat observed another
          // instance taking the lease over while the user sync was running, stop
          // here rather than carrying on alongside the new holder. The loop
          // reports it via onCycleError and drops into standby.
          lease.assertStillHeld();
          // Self-heal is a daemon-wide concern (not per-credential), gated
          // hourly. Runs after the per-user sync so a fresh tick's recompute
          // has had its chance first.
          await this.maybeSelfHealRecomputes();
          lease.assertStillHeld();
          // Hourly read-only fleet health summary so stuck/quarantined/backing-off
          // credentials are visible in the daemon logs without a manual DB query.
          await this.maybeLogSyncHealth();
        },
        resolved,
        {
          signal: controller.signal,
          onLog: this.log.bind(this),
          acquireSlot: lease.acquire,
          onCycleError: (error) => {
            const err = error instanceof Error ? error : new Error(String(error));
            this.handleError(err, {});
            this.log(`[SyncRunner] Daemon cycle failed: ${err.message}`);
          },
        },
      );
    } finally {
      await lease.stop();
      this.daemonController = null;
      this.log('[SyncRunner] Daemon mode stopped');
    }
  }

  /**
   * Best-effort single-active-instance lease, so a rolling deploy's overlapping
   * containers stop running every sync twice. NOT mutual exclusion: a holder
   * that stalls past the TTL loses the lease while still running, which is why
   * the credential claim, the shared-sync compare-and-set and the deterministic
   * notification uuid each have to be safe on their own.
   */
  private getLease(): DaemonLease {
    if (!this.lease) {
      this.lease = new DaemonLease(
        AURORA_SYNC_DAEMON,
        {
          acquireOrRenew: () =>
            acquireOrRenewDaemonLease(this.getClient().db, {
              daemonName: AURORA_SYNC_DAEMON,
              holderId: this.leaseHolderId,
              hostname: hostname(),
            }),
          release: () =>
            releaseDaemonLease(this.getClient().db, {
              daemonName: AURORA_SYNC_DAEMON,
              holderId: this.leaseHolderId,
            }),
        },
        {
          onLog: this.log.bind(this),
          onError: (error) => this.handleError(error instanceof Error ? error : new Error(String(error)), {}),
        },
      );
    }
    return this.lease;
  }

  private syncableCredentialsFilter() {
    return and(
      or(
        eq(auroraCredentials.syncStatus, 'pending'),
        eq(auroraCredentials.syncStatus, 'active'),
        eq(auroraCredentials.syncStatus, 'error'),
      ),
      isNotNull(auroraCredentials.encryptedUsername),
      isNotNull(auroraCredentials.encryptedPassword),
      isNotNull(auroraCredentials.auroraUserId),
      ne(auroraCredentials.boardType, KILTER_BOARD_TYPE),
    );
  }

  private async getActiveCredentials(): Promise<CredentialRecord[]> {
    const { db } = this.getClient();
    const credentials = await db.select().from(auroraCredentials).where(this.syncableCredentialsFilter());
    return credentials as CredentialRecord[];
  }

  /**
   * Claim the next credential to sync. The fairness ordering (attempt clock,
   * NULLS FIRST) and the backoff predicate live in claimNextCredentialForSync
   * so aurora and kilter cannot drift; only the board-specific eligibility
   * filter is supplied here.
   *
   * Ordering by the ATTEMPT clock rather than last_sync_at is load-bearing: a
   * persistently-failing credential whose last_sync_at never advances used to
   * sort to the FRONT every cycle and monopolise the single-user-per-cycle
   * queue, wedging every other user's sync — and, via the shared-sync
   * piggyback, the whole board's catalog (Touchstone went 5 months stale).
   *
   * The claim is what stops two overlapping daemon instances syncing the SAME
   * user twice: the winner locks the row with FOR UPDATE SKIP LOCKED and stamps
   * the attempt clock before committing, so the other instance skips past it to
   * the next candidate (or gets nothing and idles this cycle).
   */
  private async getNextCredentialToSync(): Promise<CredentialRecord | null> {
    const { db } = this.getClient();
    const claimed = await claimNextCredentialForSync(db, {
      candidateFilter: this.syncableCredentialsFilter(),
    });

    return claimed as CredentialRecord | null;
  }

  private async syncSingleCredential(cred: CredentialRecord): Promise<void> {
    if (!cred.encryptedUsername || !cred.encryptedPassword || !cred.auroraUserId) {
      throw new Error('Missing credentials or user ID');
    }

    const boardType = cred.boardType as AuroraBoardName;

    let username: string;
    let password: string;
    try {
      username = decrypt(cred.encryptedUsername);
      password = decrypt(cred.encryptedPassword);
    } catch (decryptError) {
      const errorMessage = `Decryption failed: ${this.formatErrorMessage(decryptError)}`;
      await this.updateCredentialStatus(cred.userId, cred.boardType, 'error', errorMessage);
      throw new CredentialSyncError(errorMessage, { syncStatus: 'error', quarantined: false });
    }

    this.log(`[SyncRunner] Getting fresh token for user ${cred.userId} (${boardType})...`);
    const auroraClient = new AuroraClimbingClient({ boardName: boardType });
    let token: string;

    try {
      const loginResponse = await auroraClient.signIn(username, password);
      if (!loginResponse.token) {
        throw new Error('Login succeeded but no token returned');
      }
      token = loginResponse.token;
    } catch (loginError) {
      if (isTransientAuroraError(loginError)) {
        this.log(
          `[SyncRunner] Transient Aurora login error for user ${cred.userId} (${boardType}); will retry later: ${(loginError as Error).message}`,
        );
        throw loginError;
      }

      const errorMessage = `Login failed: ${this.formatErrorMessage(loginError)}`;
      if (this.isInvalidCredentialError(loginError)) {
        const { storedErrorMessage, status, quarantined } = await this.recordInvalidCredentialFailure(
          cred,
          errorMessage,
        );
        throw new CredentialSyncError(storedErrorMessage, { syncStatus: status, quarantined });
      } else {
        await this.updateCredentialStatus(cred.userId, cred.boardType, 'error', errorMessage);
        throw new CredentialSyncError(errorMessage, { syncStatus: 'error', quarantined: false });
      }
    }

    await this.updateStoredToken(cred.userId, cred.boardType, token);

    const { client, db } = this.getClient();
    this.log(`[SyncRunner] Syncing user ${cred.userId} for ${boardType}...`);
    await syncUserData(client, boardType, token, cred.auroraUserId, cred.userId, undefined, this.log.bind(this));
    const succeededAt = new Date();

    // Circuits whose playlist belongs to another Boardsesh user get refused by
    // the ownership guard in upsertTableData. The cycle still counts as a
    // success — logs, bids and everything else synced fine, and flipping to
    // 'error' would stop the daemon re-picking this credential. But surface it:
    // an empty playlist list with no explanation is indistinguishable from "I
    // have no circuits", and this user has no way to know another account holds
    // the same board login (#3526).
    //
    // Asked as a STATE question, not "did this cycle refuse anything". Aurora's
    // user sync is incremental, so a cycle where nothing changed upstream
    // returns no circuit rows and would clear a per-cycle flag straight back to
    // null — the message would flash once and vanish. This version persists
    // while the duplicate link does, and clears itself when it's resolved.
    //
    // Fail-open, and deliberately so. Every row this cycle wrote is already
    // committed; the only thing left is a cosmetic status field. Letting this
    // read throw would hand the whole cycle to the catch at syncNextUser —
    // bumping consecutive_failures, widening the backoff, writing a
    // last_sync_error and leaving last_sync_at un-advanced — so a successful
    // sync would be recorded as a failure over a message. Swallow it, log it,
    // and report no duplicate; the check is a pure state read, so the next
    // cycle re-evaluates it from scratch and self-heals.
    const hasDuplicateCircuitOwner = await hasForeignOwnedCircuitPlaylists(
      db,
      boardType,
      cred.auroraUserId,
      cred.userId,
    ).catch((error: unknown) => {
      this.log(
        `[SyncRunner] Duplicate-circuit-owner check failed for user ${cred.userId} (${boardType}); treating as no duplicate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    });
    // A CODE, not a sentence. The board card is the surface that shows this,
    // and it renders in the viewer's language — so the daemon states the
    // condition and the client owns the wording.
    const duplicateCircuitOwnerError = hasDuplicateCircuitOwner ? DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR : null;
    if (duplicateCircuitOwnerError) {
      this.log(
        `[SyncRunner] User ${cred.userId}: circuits not syncing — the ${boardType} account is linked to another Boardsesh user who owns the playlists (see #3526)`,
      );
    }

    await this.updateCredentialStatus(cred.userId, cred.boardType, 'active', duplicateCircuitOwnerError, succeededAt, {
      credentialFailureCount: 0,
      lastCredentialFailureAt: null,
      // Success advances the attempt clock too (they coincide on a clean
      // cycle) and clears the backoff counter + observability error.
      lastSyncAttemptAt: succeededAt,
      consecutiveFailures: 0,
      lastSyncError: null,
    });

    // Piggyback shared sync onto user sync — the user's fresh token
    // authenticates the shared `/sync` request the same way the old Vercel
    // cron's *_SYNC_TOKEN env vars used to. Throttled per board so that N
    // consecutive user syncs for the same board don't fire N independent
    // shared-sync loops (and N copies of setter notifications for the same
    // pre-existing climbs). Failures here must not poison the user's
    // credential status, since the user-half already succeeded.
    await this.maybeRunSharedSync(boardType, token, cred.userId);
  }

  /**
   * Shared sync, throttled per board so N consecutive user-syncs on the same
   * board don't fire N shared-sync loops (and N copies of setter notifications
   * for the same pre-existing climbs).
   *
   * The cooldown lives in `board_shared_syncs` under a synthetic `__local_*`
   * cursor, claimed with a single-statement compare-and-set. It used to be an
   * in-memory Map, which failed two ways: a restart emptied it, so the first
   * cycle after every deploy re-fired a full shared sync per board; and two
   * overlapping containers each had their own, so both ran the same board-wide
   * sync at once — which is how followers got a second full set of "new climbs
   * from <setter>" notifications (new-climb detection is a pre-read of existing
   * uuids, and neither run has committed when the other reads).
   *
   * This CAS — not the daemon lease — is what makes that safe: the lease is
   * best-effort and can be held by two instances at once during a stall.
   */
  private async maybeRunSharedSync(boardType: AuroraBoardName, token: string, userId: string): Promise<void> {
    const cooldownMs = this.getSharedSyncCooldownMs();
    const { client, db } = this.getClient();
    const cursor = { boardType, cursorName: SHARED_SYNC_COOLDOWN_CURSOR };

    // Claiming stamps the cursor, so a concurrent caller (another instance, or
    // the next user-sync landing while we're still working) is turned away.
    // A DB error here must not escape: the user-half of this cycle has already
    // committed and been marked active, and letting the claim throw would
    // bubble into syncSingleCredential's caller and record a spurious
    // credential failure for a user whose sync actually succeeded.
    let claimToken: SharedSyncClaimToken | null = null;
    try {
      claimToken = await claimSharedSyncSlot(db, { ...cursor, cooldownMs });
      if (claimToken === null) {
        const lastRunAt = await readSharedSyncCursor(db, cursor);
        const agoSeconds = lastRunAt ? Math.round((Date.now() - lastRunAt.getTime()) / 1000) : null;
        this.log(
          `[SyncRunner] Skipping shared sync for ${boardType} (last run ${
            agoSeconds === null ? 'unknown' : `${agoSeconds}s`
          } ago; cooldown ${Math.round(cooldownMs / 1000)}s)`,
        );
        return;
      }
    } catch (claimError) {
      const claimErrorMessage = this.formatErrorMessage(claimError);
      this.handleError(claimError instanceof Error ? claimError : new Error(claimErrorMessage), {
        board: boardType,
        userId,
      });
      this.log(`[SyncRunner] Could not claim the shared-sync slot for ${boardType}: ${claimErrorMessage}`);
      return;
    }

    let nextCooldownMs = cooldownMs;
    try {
      this.log(`[SyncRunner] Running shared sync for ${boardType} using ${userId}'s token...`);
      await syncSharedData(client, boardType, token, this.log.bind(this));
      if (this.isLocationBoard(boardType)) {
        await syncAuroraBoardLocations({ db, board: boardType, log: this.log.bind(this) });
        await this.crawlGymWallSlice(boardType, token);
      }
    } catch (sharedError) {
      nextCooldownMs = sharedSyncCooldownAfterError(sharedError, cooldownMs);
      const sharedErrorMessage = this.formatErrorMessage(sharedError);
      this.handleError(sharedError instanceof Error ? sharedError : new Error(sharedErrorMessage), {
        board: boardType,
        userId,
      });
      this.log(
        `[SyncRunner] Shared sync for ${boardType} failed (user sync was OK; retry cooldown ${Math.round(
          nextCooldownMs / 1000,
        )}s): ${sharedErrorMessage}`,
      );
    } finally {
      // Success and permanent/unknown failures get the full cooldown from the
      // end of the work. Canonical transient Aurora failures get the shorter
      // retry cooldown. Finalization is fenced by claimToken, so a stalled
      // finisher cannot overwrite a newer claimant's full marker.
      await this.stampSharedSyncFinishedSafely(db, cursor, boardType, claimToken, cooldownMs, nextCooldownMs);
    }
  }

  /**
   * Re-stamp the cooldown cursor, swallowing (but reporting) any DB error.
   *
   * Never throws by design — every caller is in a `finally` that runs after the
   * user sync has committed, and the only cost of a missed stamp is that the
   * cooldown is measured from the start of the run rather than its end.
   */
  private async stampSharedSyncFinishedSafely(
    db: RunnerDb,
    cursor: { boardType: string; cursorName: string },
    boardType: string,
    claimToken: SharedSyncClaimToken,
    fullCooldownMs: number,
    nextCooldownMs: number,
  ): Promise<void> {
    try {
      const finalized = await stampSharedSyncFinished(db, {
        ...cursor,
        claimToken,
        fullCooldownMs,
        nextCooldownMs,
      });
      if (!finalized) {
        this.log(`[SyncRunner] Shared-sync claim ownership changed for ${boardType}; leaving the newer cursor intact`);
      }
    } catch (stampError) {
      const stampErrorMessage = this.formatErrorMessage(stampError);
      this.handleError(stampError instanceof Error ? stampError : new Error(stampErrorMessage), { board: boardType });
      this.log(`[SyncRunner] Could not re-stamp the shared-sync cooldown for ${boardType}: ${stampErrorMessage}`);
    }
  }

  private static readonly SELF_HEAL_COOLDOWN_MS = 60 * 60 * 1000;

  /**
   * Read the real wall configuration for a slice of this board's gyms.
   *
   * Aurora only exposes a gym's walls through an authenticated per-gym call, so
   * without this every gym board is published from a hardcoded per-board guess —
   * which is why every Tension gym in the world was stored as layout 10
   * ("Mirror") and almost none carried a controller serial.
   *
   * Runs a bounded slice rather than the whole fleet: at ~30 requests a minute a
   * full crawl is hours, and this shares the shared-sync slot. The hourly
   * cooldown paces it, the weekly re-read floor throttles it once every gym has
   * been read, and a first pass over the ~450 Aurora gyms completes in about a
   * day.
   *
   * Reuses the borrowed credential the shared sync is already running on, so it
   * adds no login of its own.
   *
   * EVERY failure is swallowed here. The token belongs to a real climber, and
   * this method sits inside `maybeRunSharedSync`'s try — letting a crawl error
   * escape would attribute it to their credential and could quarantine their
   * personal sync. The crawl is best-effort catalog upkeep; it must never cost
   * a user their account sync.
   */
  private async crawlGymWallSlice(board: AuroraLocationBoardName, token: string): Promise<void> {
    const { db } = this.getClient();
    try {
      const dueSourceKeys = await findGymsDueForWallCrawl(db, { provider: board, limit: GYM_WALL_CRAWL_SLICE });
      if (dueSourceKeys.length === 0) return;

      this.log(`[SyncRunner] Reading walls for ${dueSourceKeys.length} ${board} gym(s)...`);
      const fetchGymUser = createAuroraGymUserFetcherForToken({ board, token, log: this.log.bind(this) });
      const crawled = await crawlGymWallsForSourceKeys({
        db,
        board,
        sourceKeys: dueSourceKeys,
        fetchGymUser,
        log: this.log.bind(this),
      });
      this.log(`[SyncRunner] Wall crawl for ${board}: ${crawled}/${dueSourceKeys.length} gym(s) read`);
    } catch (error) {
      // Logged, never rethrown — see the contract above.
      this.log(
        `[SyncRunner] Wall crawl for ${board} failed (shared sync unaffected): ${this.formatErrorMessage(error)}`,
      );
    }
  }

  /**
   * Hourly recompute self-heal. The saveTick recompute is debounced in-process
   * with setTimeout, so a deploy drops any recompute still pending — leaving a
   * flash/send tick's updated_at ahead of the board_climb_stats row it feeds.
   * This bulk-recomputes those stale keys (one bounded batch per pass) so the
   * ascensionist counts self-correct instead of waiting for the next tick on
   * the same climb. A failure never breaks the daemon cycle.
   */
  private async maybeSelfHealRecomputes(): Promise<void> {
    const now = Date.now();
    if (this.lastSelfHealAt !== 0 && now - this.lastSelfHealAt < SyncRunner.SELF_HEAL_COOLDOWN_MS) {
      return;
    }
    // Stamp before running so a slow/erroring pass doesn't re-fire next cycle.
    this.lastSelfHealAt = now;
    try {
      const { db } = this.getClient();
      const { keysHealed } = await selfHealStaleClimbStats(db);
      if (keysHealed > 0) {
        this.log(`[SyncRunner] Recompute self-heal: re-derived ${keysHealed} stale climb-stat key(s)`);
      }
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)), {});
      this.log(`[SyncRunner] Recompute self-heal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Read-only fleet snapshot for the health summary: counts by sync_status,
   * how many syncable credentials are currently inside a backoff window, and
   * the oldest attempt clock. Scoped to aurora credentials (board_type != kilter)
   * and served by the same partial index the scheduler uses. One aggregate scan
   * over a small table — safe to run every cycle even under an overlapping
   * second daemon instance (#3539), since it never writes.
   */
  private async getSyncHealthSnapshot(): Promise<SyncHealthSnapshot> {
    const { db } = this.getClient();
    // Aurora's fleet is everything that isn't kilter; kilter-sync's runner
    // passes the complementary predicate to the same query.
    return getCredentialFleetSnapshot(db, ne(auroraCredentials.boardType, KILTER_BOARD_TYPE));
  }

  /**
   * Log the fleet health summary once an hour (in-memory gate, mirroring the
   * self-heal). Read-only; a failure never breaks the daemon cycle.
   */
  private async maybeLogSyncHealth(): Promise<void> {
    const now = Date.now();
    if (this.lastHealthSummaryAt !== 0 && now - this.lastHealthSummaryAt < SYNC_HEALTH_SUMMARY_COOLDOWN_MS) {
      return;
    }
    // Stamp before the query (not after) so a slow/erroring snapshot doesn't
    // re-fire on the very next cycle — a summary is anti-spam by design, and
    // it's fine for a one-off DB blip to skip a single hourly line.
    this.lastHealthSummaryAt = now;
    try {
      const snapshot = await this.getSyncHealthSnapshot();
      this.log(formatSyncHealthSummary(snapshot));
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)), {});
      this.log(`[SyncRunner] Sync health summary failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Reads each gym's real walls from Aurora so the map publishes the wall that
   * is actually on the gym's floor, rather than the per-board default config.
   *
   * Only wired into this explicit command, never the per-cycle shared sync at
   * `syncSharedForBoard`: the crawl is one authenticated request per gym at ~30
   * a minute, so several thousand gyms take hours. That belongs on its own
   * schedule, not inside a sync slot other work waits on.
   *
   * With no crawl credentials configured the fetcher is undefined and the sync
   * behaves exactly as it did before enrichment existed.
   */
  async syncLocations(
    board: AuroraLocationBoardName | 'all',
  ): Promise<LocationSyncSummary | Record<AuroraLocationBoardName, LocationSyncSummary>> {
    const { db } = this.getClient();
    const log = this.log.bind(this);
    if (board === 'all') {
      type GymUserFetcher = Awaited<ReturnType<typeof createAuroraGymUserFetcher>>;
      const fetchersByBoard = new Map<AuroraLocationBoardName, GymUserFetcher>();
      for (const locationBoard of AURORA_LOCATION_BOARDS) {
        fetchersByBoard.set(locationBoard, await createAuroraGymUserFetcher({ board: locationBoard, log }));
      }
      return syncAllAuroraBoardLocations({
        db,
        log,
        fetchGymUser: (locationBoard, pin) => {
          const fetcher = fetchersByBoard.get(locationBoard);
          return fetcher ? fetcher(pin) : Promise.resolve(undefined);
        },
      });
    }
    const fetchGymUser = await createAuroraGymUserFetcher({ board, log });
    return syncAuroraBoardLocations({ db, board, fetchGymUser, log });
  }

  private isLocationBoard(boardType: AuroraBoardName): boardType is AuroraLocationBoardName {
    return AURORA_LOCATION_BOARDS.includes(boardType as AuroraLocationBoardName);
  }

  private async updateCredentialStatus(
    userId: string,
    boardType: string,
    status: string,
    error: string | null,
    lastSyncAt?: Date,
    credentialFailureUpdate: CredentialFailureUpdate = {},
  ): Promise<void> {
    const { db } = this.getClient();
    const updateData: Record<string, unknown> = {
      syncStatus: status,
      syncError: error,
      updatedAt: new Date(),
    };

    if (lastSyncAt) {
      updateData.lastSyncAt = lastSyncAt;
    }

    if (credentialFailureUpdate.credentialFailureCount !== undefined) {
      updateData.credentialFailureCount = credentialFailureUpdate.credentialFailureCount;
    }

    if (credentialFailureUpdate.lastCredentialFailureAt !== undefined) {
      updateData.lastCredentialFailureAt = credentialFailureUpdate.lastCredentialFailureAt;
    }

    if (credentialFailureUpdate.lastSyncAttemptAt !== undefined) {
      updateData.lastSyncAttemptAt = credentialFailureUpdate.lastSyncAttemptAt;
    }

    if (credentialFailureUpdate.consecutiveFailures !== undefined) {
      updateData.consecutiveFailures = credentialFailureUpdate.consecutiveFailures;
    }

    if (credentialFailureUpdate.lastSyncError !== undefined) {
      updateData.lastSyncError = credentialFailureUpdate.lastSyncError;
    }

    await db
      .update(auroraCredentials)
      .set(updateData)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
  }

  private isInvalidCredentialError(error: unknown): boolean {
    return isAuroraRequestError(error) && error.code === 'invalid_credentials';
  }

  private async recordInvalidCredentialFailure(
    cred: CredentialRecord,
    errorMessage: string,
  ): Promise<{ storedErrorMessage: string; status: string; quarantined: boolean }> {
    const credentialFailureCount = (cred.credentialFailureCount ?? 0) + 1;
    const quarantined = credentialFailureCount >= MAX_CREDENTIAL_FAILURES;
    const status = quarantined ? 'expired' : 'error';
    const storedErrorMessage = quarantined
      ? `${errorMessage} (expired after ${MAX_CREDENTIAL_FAILURES} failed credential attempts; reconnect to resume sync)`
      : errorMessage;

    await this.updateCredentialStatus(cred.userId, cred.boardType, status, storedErrorMessage, undefined, {
      credentialFailureCount,
      lastCredentialFailureAt: new Date(),
    });

    if (quarantined) {
      // Distinct, greppable event at the moment the credential leaves the
      // syncable pool — the point an operator needs to prompt the user to
      // reconnect. (The generic ✗ failure line carries the same message, but
      // this token makes the quarantine transition countable in the logs.)
      this.log(
        `[SyncRunner] ✗ CREDENTIAL QUARANTINED user=${cred.userId} board=${cred.boardType} ` +
          `reason=invalid_credentials failures=${credentialFailureCount} — excluded from sync until reconnect`,
      );
    }

    return { storedErrorMessage, status, quarantined };
  }

  private async updateStoredToken(userId: string, boardType: string, token: string): Promise<void> {
    const encryptedToken = encrypt(token);
    const { db } = this.getClient();
    await db
      .update(auroraCredentials)
      .set({
        auroraToken: encryptedToken,
        credentialFailureCount: 0,
        lastCredentialFailureAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, boardType)));
  }

  async close(): Promise<void> {
    this.daemonController?.abort();
    // Release the lease BEFORE the pool closes, so a rolling deploy hands over
    // in milliseconds instead of idling out the TTL. runDaemon's finally also
    // calls stop(); it is idempotent. Racing this against client.end() would
    // lose the release to a CONNECTION_ENDED error.
    await this.lease?.stop();
    if (this.client) {
      try {
        await this.client.end();
      } finally {
        this.client = null;
        this.db = null;
      }
    }
  }

  private formatErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

export default SyncRunner;
