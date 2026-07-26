import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNotNull, or, sql } from 'drizzle-orm';

import { auroraCredentials } from '@boardsesh/db/schema';
import {
  CATALOG_SYNC_COOLDOWN_CURSOR,
  KILTER_SYNC_DAEMON,
  acquireOrRenewDaemonLease,
  claimNextCredentialForSync,
  claimSharedSyncSlot,
  readSharedSyncCursor,
  releaseDaemonLease,
  snapshotClimbStatsHistoryIfDue,
  stampSharedSyncFinished,
  isWeeklyCursorDue,
  markWeeklyCursorDone,
} from '@boardsesh/db/queries';
import { decrypt, encrypt } from '@boardsesh/crypto';
import {
  DEFAULT_DAEMON_OPTIONS,
  DaemonLease,
  resolveDaemonOptions,
  runDaemonLoop,
  type ResolvedDaemonOptions,
  type DaemonOptions,
} from '@boardsesh/sync-runtime';
import { DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR } from '@boardsesh/shared-schema/sync-error-codes';
import type { LocationSyncSummary } from '@boardsesh/location-sync';

import { KILTER_BOARD_TYPE } from '../api/types';
import { isTransientKilterError, KilterApiError } from '../api/errors';
import { refreshAccessToken, type KeycloakClientConfig } from '../api/keycloak';
import { passwordTokenProvider, refreshTokenProvider, type KilterTokenProvider } from '../api/token-provider';
import { syncKilterUserData } from '../sync/user-sync';
import { syncKilterCatalog, type KilterCatalogSummary } from '../sync/catalog-sync';
import { repairKilterCatalogStats, type KilterStatsRepairSummary } from '../sync/stats-repair';
import { buildLayoutResolver } from '../sync/layout-resolver';
import { syncKilterLocations, pullKilterReference } from '../sync';
import type { RunnerClient, RunnerDb, SyncRunnerConfig, SyncSummary, KilterCredentialRecord } from './types';

// Catalog cooldown: a full per-cycle catalog pull is expensive, so the daemon
// piggyback runs it at most once per window. Persisted in board_shared_syncs
// (compare-and-set), mirroring aurora-sync's shared-sync cooldown; overridable
// via config.sharedSyncCooldownMs.
const DEFAULT_CATALOG_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

export class SyncRunner {
  private config: SyncRunnerConfig;
  private daemonController: AbortController | null = null;
  private client: RunnerClient | null = null;
  private db: RunnerDb | null = null;
  private lease: DaemonLease | null = null;
  // Per-process identity for the daemon lease, minted once so a renewal reads
  // as "still us" rather than a takeover.
  private readonly leaseHolderId = randomUUID();

  constructor(config: SyncRunnerConfig = {}) {
    this.config = config;
  }

  private getCatalogSyncCooldownMs(): number {
    return this.config.sharedSyncCooldownMs ?? DEFAULT_CATALOG_SYNC_COOLDOWN_MS;
  }

  private getClient(): { client: RunnerClient; db: RunnerDb } {
    if (!this.client || !this.db) {
      const connectionString = process.env.DATABASE_URL || process.env.DB_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL or DB_URL is required');
      }
      // prepare: false matches aurora-sync — Railway's pooled URL uses
      // PgBouncer in transaction mode, which is incompatible with prepared
      // statements. Direct (non-pooled) URLs work either way, so this is
      // the safe default for both.
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

  private getKeycloakClient(): KeycloakClientConfig {
    const clientId = process.env.KILTER_OAUTH_CLIENT_ID;
    if (!clientId) {
      throw new Error('KILTER_OAUTH_CLIENT_ID is required for kilter-sync');
    }
    return {
      clientId,
      // Confidential clients only: leave unset for public PKCE clients.
      clientSecret: process.env.KILTER_OAUTH_CLIENT_SECRET,
    };
  }

  private log(message: string): void {
    if (this.config.onLog) {
      this.config.onLog(message);
    } else {
      console.info(message);
    }
  }

  private handleError(error: Error, context: { userId?: string; board?: string }): void {
    if (this.config.onError) {
      this.config.onError(error, context);
    } else {
      console.error(`[KilterSyncRunner] Error:`, error, context);
    }
  }

  /**
   * Sync exactly one user — the daemon's per-cycle unit. Picks the oldest
   * `last_sync_attempt_at` (NULLs first) credential that's neither disabled nor
   * permanently errored.
   */
  async syncNextUser(): Promise<SyncSummary> {
    const summary: SyncSummary = { total: 1, successful: 0, failed: 0, errors: [] };
    const { db } = this.getClient();

    // Candidate selection is inside the try so a DB failure here is handled
    // by the same path as a per-credential failure (and, in the daemon, by
    // runDaemonLoop's onCycleError) instead of escaping unlogged.
    let cred: KilterCredentialRecord | null = null;
    try {
      cred = await this.getNextCredentialToSync(db);
      if (!cred) {
        summary.total = 0;
        return summary;
      }

      await this.runCycleForCredential(db, cred);
      summary.successful = 1;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // A failure before we even picked a credential (e.g. the selection
      // query itself) has no user to stamp — surface it and bail.
      if (!cred) {
        this.handleError(err, { board: KILTER_BOARD_TYPE });
        summary.failed = 1;
        summary.errors.push({ userId: '', boardType: KILTER_BOARD_TYPE, error: err.message });
        return summary;
      }

      const transient = isTransientKilterError(err);

      if (transient) {
        // Leave syncStatus/syncError untouched (a genuine transient must
        // not get flagged 'error' in the UI) and DO NOT touch last_sync_at
        // (that timestamp is the user-facing "last successful sync" — a
        // failed cycle must never advance it). But DO record the failure so
        // it stops being silent: stamp last_sync_attempt_at (the scheduler's
        // fairness clock), bump consecutive_failures (drives backoff), and
        // write last_sync_error (observability — this is how an operator sees
        // WHY a card that still reads 'active' hasn't actually synced). Before
        // this, a transient-looping credential advanced NOTHING user-visible:
        // last_sync_at stayed put, no error was recorded, and the daemon
        // silently re-attempted it forever. That was the live kilter outage.
        //
        // No data is lost: last_sync_attempt_at is ONLY a scheduling key
        // (which credential to pick next), never a data cursor. Each cycle
        // re-pulls the FULL PowerSync snapshot and the apply is idempotent
        // (dedup + natural-key adoption + ON CONFLICT), so rows missed by a
        // failed cycle are re-applied on the credential's next successful
        // turn. If the pull ever becomes incremental, that watermark needs
        // its own column — it must not piggyback on this attempt clock.
        const attemptAt = new Date();
        await db
          .update(auroraCredentials)
          .set({
            lastSyncAttemptAt: attemptAt,
            consecutiveFailures: sql`COALESCE(${auroraCredentials.consecutiveFailures}, 0) + 1`,
            lastSyncError: err.message,
            updatedAt: attemptAt,
          })
          .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));

        this.log(
          `[KilterSyncRunner] Transient sync failure for user ${cred.userId} (attempt ${
            (cred.consecutiveFailures ?? 0) + 1
          }, backing off): ${err.message}`,
        );
        this.handleError(err, { userId: cred.userId, board: KILTER_BOARD_TYPE });
        summary.failed = 1;
        summary.errors.push({ userId: cred.userId, boardType: KILTER_BOARD_TYPE, error: err.message });
        return summary;
      }

      // Permanent failure — mark errored so the next cycle picks a
      // different user. invalid_grant maps to 'expired' specifically so
      // the UI knows to prompt re-auth instead of "something went wrong".
      const isExpired = err instanceof KilterApiError && err.code === 'invalid_grant';
      const status = isExpired ? 'expired' : 'error';
      // Stamp last_sync_attempt_at on the permanent path too (NOT
      // last_sync_at — a failed cycle is not a successful sync). 'expired'
      // is excluded from selection so it can't be re-picked, but 'error'
      // stays in the candidate set — without the attempt stamp an errored
      // credential with a NULL attempt time would keep sorting first and
      // monopolise the queue. (See the transient branch for the rationale.)
      // Also bump consecutive_failures + record last_sync_error: an 'error'
      // credential is still retried, so it must back off; 'unknown'/unknown
      // throws now land here (fail-closed) and get an observable message.
      const attemptAt = new Date();
      await db
        .update(auroraCredentials)
        .set({
          syncStatus: status,
          syncError: err.message,
          lastSyncError: err.message,
          consecutiveFailures: sql`COALESCE(${auroraCredentials.consecutiveFailures}, 0) + 1`,
          lastSyncAttemptAt: attemptAt,
          updatedAt: attemptAt,
        })
        .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));

      this.log(
        `[KilterSyncRunner] Permanent sync failure for user ${cred.userId} (status=${status}, attempt ${
          (cred.consecutiveFailures ?? 0) + 1
        }): ${err.message}`,
      );
      this.handleError(err, { userId: cred.userId, board: KILTER_BOARD_TYPE });
      summary.failed = 1;
      summary.errors.push({ userId: cred.userId, boardType: KILTER_BOARD_TYPE, error: err.message });
    }

    return summary;
  }

  /**
   * Force a sync for a specific user (CLI `kilter-sync user <userId>`).
   * Errors propagate to the caller so a CLI run prints the failure.
   */
  async syncUser(userId: string): Promise<void> {
    const { db } = this.getClient();
    const cred = await this.getCredential(db, userId);
    if (!cred) {
      throw new Error(`No kilter credential for user ${userId}`);
    }
    await this.runCycleForCredential(db, cred);
  }

  private async runCycleForCredential(db: RunnerDb, cred: KilterCredentialRecord): Promise<void> {
    const accessToken = await this.refreshTokenFor(cred, db);

    const { skippedForeignCircuits } = await syncKilterUserData({
      db,
      userId: cred.userId,
      accessToken,
      log: (msg) => this.log(msg),
    });

    // TODO(push-back): wire pushKilterUserData(...) in here, between the
    // user-sync above and the credential stamp below. It is deliberately not
    // called yet — push-back (Boardsesh → Kilter for ticks/ratings/circuits)
    // stays gated behind KILTER_SYNC_PUSH_ENABLED until the REST payloads are
    // verified against a real Kilter account. Pull already works end-to-end;
    // push waits on that verification pass because it writes to a real Kilter
    // database, which we shouldn't do speculatively from sync. A future
    // enabler reads KILTER_SYNC_PUSH_ENABLED and invokes the call at this
    // point. See packages/kilter-sync/src/sync/push-back.ts.

    // Success: advance BOTH clocks. last_sync_at is the user-facing "last
    // successful sync"; last_sync_attempt_at is the scheduler's fairness
    // clock (also advanced on failure). On a clean cycle they coincide.
    //
    // The cycle still counts as a success when circuits were skipped — logs,
    // ratings and every other object type synced fine, and flipping the
    // credential to 'error' would stop the daemon re-picking it. But we do
    // write a user-facing sync_error: an empty playlist list with no
    // explanation is indistinguishable from "I have no circuits", and this
    // user has no way to know another Boardsesh account holds the same board
    // login (#3526).
    //
    // A CODE, not a sentence. The board card is the surface that shows this,
    // and it renders in the viewer's language — so the daemon states the
    // condition and the client owns the wording.
    const now = new Date();
    const duplicateCircuitOwnerError = skippedForeignCircuits > 0 ? DUPLICATE_BOARD_ACCOUNT_CIRCUITS_SYNC_ERROR : null;
    if (duplicateCircuitOwnerError) {
      this.log(
        `[KilterSyncRunner] User ${cred.userId}: ${skippedForeignCircuits} circuit(s) skipped — the Kilter account is linked to another Boardsesh user (see #3526)`,
      );
    }
    await db
      .update(auroraCredentials)
      .set({
        lastSyncAt: now,
        lastSyncAttemptAt: now,
        syncStatus: 'active',
        syncError: duplicateCircuitOwnerError,
        // Success clears the failure counters so backoff resets and the
        // observability field stops showing a stale error.
        consecutiveFailures: 0,
        lastSyncError: null,
        updatedAt: now,
      })
      .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));

    // Piggyback: after the user-half succeeds and is stamped active, refresh
    // the shared catalog if its cooldown has elapsed. Reuses this user's token.
    await this.maybeRunCatalogSync(db, cred, accessToken);
  }

  /**
   * Catalog refresh ridden in after a user sync. Cooldown is claimed with a
   * single-statement compare-and-set on a synthetic `board_shared_syncs` cursor
   * and re-stamped after the run (success or failure) so a slow or erroring
   * catalog can't monopolise cycles. A catalog failure never poisons the user's
   * credential — the user-half already committed.
   *
   * Persisting the cooldown (it used to be a per-process Map) is what stops two
   * overlapping daemon instances running the same catalog pull at once and
   * emitting a second full set of setter notifications, and stops every restart
   * re-firing a full catalog pull on its first cycle. The daemon lease is only
   * an optimisation — it can legitimately be held by two instances during a
   * stall — so this claim carries the guarantee.
   */
  private async maybeRunCatalogSync(db: RunnerDb, cred: KilterCredentialRecord, currentToken: string): Promise<void> {
    const board = KILTER_BOARD_TYPE;
    const cooldownMs = this.getCatalogSyncCooldownMs();
    const cursor = { boardType: board, cursorName: CATALOG_SYNC_COOLDOWN_CURSOR };

    // A DB error here must not escape: the user-half of this cycle has already
    // committed and been marked active, so letting the claim throw would record
    // a spurious credential failure for a user whose sync actually succeeded.
    let claimed = false;
    try {
      claimed = await claimSharedSyncSlot(db, { ...cursor, cooldownMs });
      if (!claimed) {
        const lastRun = await readSharedSyncCursor(db, cursor);
        const remainingMinutes = lastRun
          ? Math.max(0, Math.round((cooldownMs - (Date.now() - lastRun.getTime())) / 60000))
          : null;
        this.log(
          `[kilter-catalog] skipped — within cooldown (${
            remainingMinutes === null ? 'held by another instance' : `${remainingMinutes}m left`
          })`,
        );
      }
    } catch (claimError) {
      this.handleError(claimError instanceof Error ? claimError : new Error(String(claimError)), { board });
      return;
    }

    if (!claimed) return;

    // Reuse the just-minted user token first, then re-mint on demand (the
    // catalog pull can outlast a single access-token TTL).
    let cachedToken: string | null = currentToken;
    const tokenProvider: KilterTokenProvider = async () => {
      if (cachedToken !== null) {
        const token = cachedToken;
        cachedToken = null;
        return token;
      }
      return this.refreshTokenFor(cred, db);
    };

    try {
      // Deletions default ON: batched, reversible (soft-delete), and scoped to
      // Kilter-synced climbs only (never user-authored). See deletions.ts.
      await syncKilterCatalog({
        db,
        tokenProvider,
        log: (message) => this.log(message),
        applyDeletions: this.config.applyCatalogDeletions ?? true,
        deleteBatchLimit: this.config.deleteBatchLimit,
      });

      // After a fresh catalog pull, run the two weekly board-wide maintenance
      // jobs (each self-gated by a 7-day watermark, so calling them every
      // catalog cycle is cheap). A failure in either must not poison the
      // catalog result — the counts already committed.
      await this.maybeRepairKilterStats(db, tokenProvider);
      await this.maybeSnapshotHistory(db);
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)), { board });
    } finally {
      // Re-stamp so the cooldown runs from the END of the work, success or not.
      // Error-swallowing by design: this runs after the user-half has committed
      // and been marked active, so a DB error here must not escape and record a
      // credential failure for a user whose sync actually succeeded.
      await this.stampCatalogSyncFinishedSafely(db, cursor);
    }
  }

  /**
   * Re-stamp the catalog cooldown cursor, swallowing (but reporting) any DB
   * error. Never throws — the only cost of a missed stamp is that the cooldown
   * is measured from the start of the run rather than its end. Mirrors
   * aurora-sync's stampSharedSyncFinishedSafely so the two runners keep the
   * same error-handling shape.
   */
  private async stampCatalogSyncFinishedSafely(
    db: RunnerDb,
    cursor: { boardType: string; cursorName: string },
  ): Promise<void> {
    try {
      await stampSharedSyncFinished(db, cursor);
    } catch (stampError) {
      this.handleError(stampError instanceof Error ? stampError : new Error(String(stampError)), {
        board: KILTER_BOARD_TYPE,
      });
    }
  }

  // Synthetic board_shared_syncs cursor gating the weekly stats-repair.
  private static readonly KILTER_STATS_REPAIR_CURSOR = '__local_kilter_stats_repair__';

  /**
   * Weekly kilter stats-repair (repairKilterCatalogStats with --apply): the
   * downward count reconciliation + alias-fold drift fix that had no scheduler.
   * Gated by a 7-day board_shared_syncs watermark, run after the catalog sync
   * with the same token provider. Errors are swallowed (logged) so a repair
   * failure never fails the catalog cycle.
   */
  private async maybeRepairKilterStats(db: RunnerDb, tokenProvider: KilterTokenProvider): Promise<void> {
    if (!(await isWeeklyCursorDue(db, KILTER_BOARD_TYPE, SyncRunner.KILTER_STATS_REPAIR_CURSOR))) {
      return;
    }
    this.log('[kilter-stats-repair] weekly reconciliation is due — applying');
    try {
      const summary = await repairKilterCatalogStats({
        db,
        tokenProvider,
        apply: true,
        log: (message) => this.log(message),
      });
      // Commit the watermark only on success so a failed repair retries next
      // cycle instead of skipping the week.
      await markWeeklyCursorDone(db, KILTER_BOARD_TYPE, SyncRunner.KILTER_STATS_REPAIR_CURSOR);
      this.log(
        `[kilter-stats-repair] applied — ${summary.changedKilterRows} count rows, ` +
          `${summary.formulaRowsRecomputed} formula rows`,
      );
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)), { board: KILTER_BOARD_TYPE });
    }
  }

  /** Weekly board_climb_stats_history snapshot for kilter (see item 5). */
  private async maybeSnapshotHistory(db: RunnerDb): Promise<void> {
    try {
      await snapshotClimbStatsHistoryIfDue(db, KILTER_BOARD_TYPE, (message) => this.log(message));
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)), { board: KILTER_BOARD_TYPE });
    }
  }

  /**
   * Run a catalog sync directly (CLI `kilter-sync catalog`). The caller
   * supplies the token provider (refresh-grant for a linked user, or ROPC for
   * local testing). Errors propagate so the CLI surfaces them.
   */
  async runCatalogSync(
    tokenProvider: KilterTokenProvider,
    opts: {
      applyDeletions?: boolean;
      deleteBatchLimit?: number;
      layoutUuids?: string[];
      suppressNotifications?: boolean;
    } = {},
  ): Promise<KilterCatalogSummary> {
    const { db } = this.getClient();
    return syncKilterCatalog({
      db,
      tokenProvider,
      log: (message) => this.log(message),
      applyDeletions: opts.applyDeletions,
      deleteBatchLimit: opts.deleteBatchLimit,
      layoutUuids: opts.layoutUuids,
      suppressNotifications: opts.suppressNotifications,
    });
  }

  async runLocationSync(tokenProvider: KilterTokenProvider): Promise<LocationSyncSummary> {
    const { db } = this.getClient();
    const accessToken = await tokenProvider();
    const reference = await pullKilterReference({ accessToken, log: (message) => this.log(message) });
    const resolver = await buildLayoutResolver(db);
    return syncKilterLocations({ db, reference, resolver, log: (message) => this.log(message) });
  }

  async repairCatalogStats(
    tokenProvider: KilterTokenProvider,
    opts: { apply?: boolean; layoutUuids?: string[] } = {},
  ): Promise<KilterStatsRepairSummary> {
    const { db } = this.getClient();
    return repairKilterCatalogStats({
      db,
      tokenProvider,
      apply: opts.apply,
      layoutUuids: opts.layoutUuids,
      log: (message) => this.log(message),
    });
  }

  /** Build a refresh-grant token provider from a linked user's stored credential. */
  async buildUserTokenProvider(userId: string): Promise<KilterTokenProvider> {
    const { db } = this.getClient();
    const cred = await this.getCredential(db, userId);
    if (!cred) throw new Error(`No kilter credential for user ${userId}`);
    if (!cred.encryptedRefreshToken)
      throw new Error(`Kilter credential for ${userId} has no refresh token — user must reconnect`);
    return refreshTokenProvider({
      encryptedRefreshToken: cred.encryptedRefreshToken,
      client: this.getKeycloakClient(),
      onRotatedRefreshToken: async (newRefreshToken) => {
        await db
          .update(auroraCredentials)
          .set({ encryptedRefreshToken: encrypt(newRefreshToken), updatedAt: new Date() })
          .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));
      },
    });
  }

  /** Build a ROPC token provider for local testing (KILTER_TEST_USERNAME/PASSWORD). */
  buildPasswordTokenProvider(username: string, password: string): KilterTokenProvider {
    return passwordTokenProvider({ username, password, client: this.getKeycloakClient() });
  }

  private async refreshTokenFor(cred: KilterCredentialRecord, db: RunnerDb): Promise<string> {
    if (!cred.encryptedRefreshToken) {
      throw new KilterApiError(
        'invalid_grant',
        `Kilter credential for ${cred.userId} has no refresh token — user must reconnect`,
      );
    }

    const refreshToken = decrypt(cred.encryptedRefreshToken);
    const response = await refreshAccessToken({
      refreshToken,
      client: this.getKeycloakClient(),
    });

    // Keycloak rotates refresh tokens on each refresh by default. Persist
    // the new one (encrypted) so the next cycle uses the fresh value;
    // re-using a stale refresh_token after rotation gets you invalid_grant.
    // This is a deliberate immediate autocommit done before the rest of the
    // sync runs — there's no transaction wrapping the cycle, so this write
    // lands on its own. We do it eagerly to minimise the rotation-loss
    // window: if the process crashes between Keycloak issuing the rotated
    // token and this write committing, the old refresh_token is already
    // invalid and the user must re-auth on the next cycle.
    if (response.refresh_token && response.refresh_token !== refreshToken) {
      await db
        .update(auroraCredentials)
        .set({
          encryptedRefreshToken: encrypt(response.refresh_token),
          updatedAt: new Date(),
        })
        .where(and(eq(auroraCredentials.userId, cred.userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)));
    }

    return response.access_token;
  }

  /**
   * Filter mirrors aurora-sync's syncableCredentialsFilter — board_type
   * scoped, refresh token present, syncStatus ∈ {pending, active, error}
   * (skip disabled + expired).
   */
  private syncableCredentialsFilter() {
    return and(
      eq(auroraCredentials.boardType, KILTER_BOARD_TYPE),
      // Dead password-era links (encrypted_refresh_token IS NULL) are the
      // pre-OAuth credentials that can no longer sync. Migration 0171
      // reconciled the existing ones to sync_status='expired' with an
      // accurate re-link message; this filter is the explicit, permanent
      // skip so they never re-enter the hot selection path (and never
      // spam a per-cycle log). Surfacing a re-link prompt in the UI is a
      // separate product follow-up.
      isNotNull(auroraCredentials.encryptedRefreshToken),
      // The allowed set is positive (pending/active/error). 'expired'
      // and 'disabled' are excluded by omission — adding explicit
      // ne() clauses for them would be dead code given the or().
      or(
        eq(auroraCredentials.syncStatus, 'pending'),
        eq(auroraCredentials.syncStatus, 'active'),
        eq(auroraCredentials.syncStatus, 'error'),
      ),
    );
  }

  /**
   * Claim the next credential. The fairness ordering (attempt clock, NULLS
   * FIRST) and the exponential-backoff predicate live in
   * claimNextCredentialForSync, shared with aurora-sync so the two can't drift.
   *
   * The claim — FOR UPDATE SKIP LOCKED plus an attempt-clock stamp inside one
   * short transaction — is what stops two overlapping daemon instances picking
   * the same user and syncing them twice.
   */
  private async getNextCredentialToSync(db: RunnerDb): Promise<KilterCredentialRecord | null> {
    return claimNextCredentialForSync(db, { candidateFilter: this.syncableCredentialsFilter() });
  }

  private async getCredential(db: RunnerDb, userId: string): Promise<KilterCredentialRecord | null> {
    const rows = await db
      .select({
        userId: auroraCredentials.userId,
        boardType: auroraCredentials.boardType,
        encryptedRefreshToken: auroraCredentials.encryptedRefreshToken,
        syncStatus: auroraCredentials.syncStatus,
        syncError: auroraCredentials.syncError,
        lastSyncAt: auroraCredentials.lastSyncAt,
        consecutiveFailures: auroraCredentials.consecutiveFailures,
      })
      .from(auroraCredentials)
      .where(and(eq(auroraCredentials.userId, userId), eq(auroraCredentials.boardType, KILTER_BOARD_TYPE)))
      .limit(1);

    return rows[0] ?? null;
  }

  async runDaemon(options: DaemonOptions = {}): Promise<void> {
    const resolved: ResolvedDaemonOptions = resolveDaemonOptions(options);
    this.daemonController = new AbortController();
    const lease = this.getLease();
    try {
      await runDaemonLoop(
        async () => {
          await this.syncNextUser();
          // Checkpoint: if a heartbeat saw another instance take the lease over
          // while this cycle ran, stop here instead of continuing alongside the
          // new holder. The loop reports it and drops into standby.
          lease.assertStillHeld();
        },
        resolved,
        {
          signal: this.daemonController.signal,
          onLog: (m: string) => this.log(m),
          acquireSlot: lease.acquire,
          // syncNextUser handles per-credential failures internally; this
          // catches anything that escapes a cycle (e.g. an unexpected throw)
          // so it's logged + reported to Sentry instead of silently dropped.
          onCycleError: (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            this.handleError(err, { board: KILTER_BOARD_TYPE });
            this.log(`[KilterSyncRunner] Daemon cycle error: ${err.message}`);
          },
        },
      );
    } finally {
      await lease.stop();
      this.daemonController = null;
    }
  }

  /**
   * Best-effort single-active-instance lease so overlapping deploy containers
   * stop doing every sync twice. NOT mutual exclusion — a stalled holder loses
   * the lease while still running, which is why the credential claim, the
   * catalog compare-and-set and the deterministic notification uuid each stand
   * on their own.
   */
  private getLease(): DaemonLease {
    if (!this.lease) {
      this.lease = new DaemonLease(
        KILTER_SYNC_DAEMON,
        {
          acquireOrRenew: () =>
            acquireOrRenewDaemonLease(this.getClient().db, {
              daemonName: KILTER_SYNC_DAEMON,
              holderId: this.leaseHolderId,
              hostname: hostname(),
            }),
          release: () =>
            releaseDaemonLease(this.getClient().db, {
              daemonName: KILTER_SYNC_DAEMON,
              holderId: this.leaseHolderId,
            }),
        },
        {
          onLog: (message) => this.log(message),
          onError: (error) =>
            this.handleError(error instanceof Error ? error : new Error(String(error)), {
              board: KILTER_BOARD_TYPE,
            }),
        },
      );
    }
    return this.lease;
  }

  async stop(): Promise<void> {
    this.daemonController?.abort();
    // Release before the pool closes so a rolling deploy hands over in
    // milliseconds instead of idling out the TTL. stop() is idempotent, so
    // runDaemon's finally calling it too is harmless.
    await this.lease?.stop();
    if (this.client) {
      await this.client.end({ timeout: 5 });
      this.client = null;
      this.db = null;
    }
  }
}

export { DEFAULT_DAEMON_OPTIONS };
