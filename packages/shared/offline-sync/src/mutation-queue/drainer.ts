import type { OfflineDatabase, QueryInvalidator } from '../database';
import type { GraphQLFetch } from './handlers';
import { processMutation } from './handlers';
import { peekPending, markCompleted, recordFailure, markDeadLetter } from './queue';
import { isGraphQLEmptyResponseError, isRetryable, isNetworkError } from './error-classification';

// Module-level singletons (drain flag, sign-out guard, wipe epoch): correct as
// long as exactly one app runtime consumes this package per JS context — the
// guards coordinate the drainer, the pull client, and sign-out, which all live
// in that one context.
let _isDraining = false;

// Sign-out guard (account lifecycle): while sign-out is wiping local user data,
// a scheduler- or listener-triggered drain must not run concurrently — it could
// race clearUserData's DELETEs (reading half-cleared rows) or re-touch the DB
// mid-wipe. Sign-out sets this before clearUserData and clears it after; any
// drain entered while it's set early-returns. The one bounded drain sign-out
// itself performs runs BEFORE the flag is set, so it isn't blocked.
let _isSigningOut = false;

// Monotonic wipe generation. The boolean above is true only for the
// milliseconds clearUserData takes, so an async operation whose network await
// was in flight during that window sees `false` on both sides of it and would
// happily write the old user's data back after the wipe (or, in a drain, post
// the old user's queued writes under the NEXT user's token). Long-running
// operations capture the epoch at start and abort when it has moved.
let _wipeEpoch = 0;

export function setSigningOut(value: boolean): void {
  if (value && !_isSigningOut) _wipeEpoch += 1;
  _isSigningOut = value;
}

/**
 * Bump the wipe epoch WITHOUT asserting sign-out.
 *
 * A local purge — removing one board scope's downloaded catalog (issue #3617) — has
 * the same hazard sign-out does: a pull page already on the wire lands after the
 * delete and resurrects part of the catalog, complete with a checkpoint past it,
 * which the strict `>` delta pull then never revisits. Every long-running pull path
 * already re-checks getWipeEpoch() across its awaits (syncTable checks at each page
 * top AND again right after the fetch await, before upsertDocuments — that second
 * check is the one that discards the in-flight page), so bumping the epoch reuses
 * those guards verbatim rather than inventing a second mechanism for one hazard.
 *
 * Deliberately not setSigningOut(true): that also flips _isSigningOut, which halts
 * drainMutationQueue (the user's unsynced ticks have nothing to do with a board
 * catalog) and would need a paired setSigningOut(false) that races a real concurrent
 * sign-out and clears ITS flag.
 *
 * There is no endLocalPurge: the epoch is monotonic, so there's no flag to unset,
 * nothing to leak, and no cleanup that a throw could skip. In-flight cycles captured
 * the old value and bail; the next cycle captures the new one and proceeds normally.
 * It does abort other scopes' pulls too — they resume from intact checkpoints on the
 * next trigger, so the cost is one cycle.
 */
export function beginLocalPurge(): void {
  _wipeEpoch += 1;
}

// Read by the pull client too: an in-flight pullSync page must stop writing the
// old user's rows once sign-out starts wiping — otherwise a page landing after
// clearUserData resurrects data the next signed-in account could briefly see.
export function isSigningOut(): boolean {
  return _isSigningOut;
}

export function getWipeEpoch(): number {
  return _wipeEpoch;
}

// Backgrounding guard (Sentry BOARDSESH-AN), same shape as the sign-out guard above.
let _isBackgrounded = false;

export function setBackgrounded(value: boolean): void {
  _isBackgrounded = value;
}

export function isBackgrounded(): boolean {
  return _isBackgrounded;
}

// Bounded exponential backoff between drain attempts within a single cycle
// (I7). A transient failure (network blip, 5xx) recovers on its own instead of
// stalling until the next external trigger. Capped so we never busy-loop or
// retry forever inside one drain.
const DEFAULT_MAX_CYCLE_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

export type DrainOptions = {
  /** Injectable sleep for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Max retryable attempts within one drain cycle before giving up. */
  maxCycleAttempts?: number;
  /** First backoff delay; doubles each attempt. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. */
  maxDelayMs?: number;
  /**
   * Connectivity probe. When it reports offline the drain is skipped entirely
   * so a queued write never burns retry attempts while there's no connection.
   * REQUIRED (no default): "assume online" silently burns retries offline and
   * "assume offline" silently never syncs, so the caller must decide. The app
   * adapter binds the real probe once (mobile passes React Query's
   * onlineManager, wired to NetInfo) — see
   * packages/mobile/src/offline/offline-sync-adapter.ts; tests pass a literal.
   */
  isOnline: () => boolean;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff: random in [0, min(cap, base * 2^attempt)].
// `attempt` is 0-based (first retry after a failure uses attempt 0).
function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * exponential);
}

function invalidateForTable(queryClient: QueryInvalidator, tableName: string): void {
  const keyMap: Record<string, string[][]> = {
    // ['climb'] + ['localTicks'] so the climb detail's server counts refetch and
    // the "waiting to sync" badge clears once a tick actually reaches the server.
    boardsesh_ticks: [['ticks'], ['logbook'], ['climb'], ['localTicks']],
    // ['favoriteStatus'] so the per-climb heart refetches AFTER the queued
    // favorite lands — the optimistic write at enqueue time can be overwritten
    // by a network refetch that raced the drain.
    user_favorites: [['favorites'], ['searchClimbs'], ['infiniteSearchClimbs'], ['favoriteStatus']],
    playlists: [['playlists']],
    playlist_climbs: [['playlists']],
    user_follows: [['followers'], ['following']],
    setter_follows: [['setterFollows']],
    playlist_follows: [['playlistFollows']],
    user_playlist_pins: [['playlists']],
    // Board tables aren't mutation-driven today, but if a board-table write ever
    // drains, point it at the keys real readers use (mirrors table-config.ts).
    board_climbs: [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']],
    board_climb_stats: [['searchClimbs'], ['infiniteSearchClimbs'], ['searchClimbsCount'], ['climb']],
  };
  const keys = keyMap[tableName];
  if (!keys) {
    // table_name is a plain string, so a NEW mutation type missing from the
    // map compiles fine and drains fine — but its UI would never refresh.
    // Surface the gap loudly in dev instead of silently skipping. (NODE_ENV is
    // the platform-free stand-in for RN's __DEV__ — Metro inlines it the same
    // way, and this package has no react-native globals.)
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[MutationQueue] no invalidation keys mapped for table "${tableName}" — UI will not refresh`);
    }
    return;
  }
  for (const key of keys) {
    queryClient.invalidateQueries({ queryKey: key });
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function drainMutationQueue(
  db: OfflineDatabase,
  queryClient: QueryInvalidator,
  graphqlFetch: GraphQLFetch,
  options: DrainOptions,
): Promise<void> {
  // Don't start (or re-enter) a drain while sign-out is wiping local data.
  if (_isSigningOut) return;
  if (_isBackgrounded) return;
  if (_isDraining) return;
  // Offline: nothing can be pushed, and attempting would only churn retry counts
  // and burn backoff sleeps. Skip; the reconnect/foreground trigger drains later.
  if (!options.isOnline()) return;
  _isDraining = true;

  const sleep = options.sleep ?? defaultSleep;
  const maxCycleAttempts = options.maxCycleAttempts ?? DEFAULT_MAX_CYCLE_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  // Counts only retryable failures within this cycle. A successful batch resets
  // it, so a long healthy queue never exhausts the budget.
  let retryAttempts = 0;

  // Abort the moment a sign-out wipe starts (or completes) mid-drain: the rows
  // being replayed belong to the signing-out user, and graphqlFetch resolves
  // the CURRENT token per request — a drain tail that outlives the account
  // switch would post the old user's writes into the new user's account.
  const startEpoch = _wipeEpoch;

  try {
    while (true) {
      if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded) break;
      const batch = await peekPending(db, 10);
      if (batch.length === 0) break;

      let retryableHit = false;
      let networkStop = false;

      for (const mutation of batch) {
        if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded) {
          networkStop = true; // reuse the "end cycle now" path
          break;
        }
        try {
          await processMutation(mutation, graphqlFetch);
          // Re-check after the network await: backgrounding (or a sign-out wipe)
          // may have started while the send was in flight. The send already
          // reached the server, but the local bookkeeping write must not — leave
          // the row pending (idempotency_key makes a resend on the next drain
          // safe) rather than dispatch a SQLite call right as iOS suspends.
          if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded) {
            networkStop = true; // reuse the "end cycle now" path
            break;
          }
          await markCompleted(db, mutation.id);
          invalidateForTable(queryClient, mutation.table_name);
        } catch (error: unknown) {
          const errorMessage = formatError(error);

          if (isGraphQLEmptyResponseError(error)) {
            // A 2xx response with no usable GraphQL body is ambiguous: the
            // idempotent write may have landed, but no server verdict reached
            // the client. Retry it within this cycle's existing bounded budget
            // without consuming the mutation's persistent retry/dead-letter
            // budget. Unlike a reachability failure, this does not require an
            // offline→online transition before another attempt can succeed.
            retryableHit = true;
            break;
          }

          if (isNetworkError(error)) {
            // The connection dropped mid-drain. Leave this mutation PENDING without
            // advancing retry_count — an offline write must never dead-letter for
            // lack of a connection; it drains when connectivity returns. Stop the
            // cycle rather than backing off against a network that's gone.
            networkStop = true;
            break;
          }

          // Same re-check as the success path above, before the retry/dead-letter
          // bookkeeping writes below.
          if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded) {
            networkStop = true;
            break;
          }

          if (isRetryable(error)) {
            // One atomic UPDATE bumps the retry and, when the bumped count hits
            // max_retries, flips to dead_letter — no window where the row is
            // exhausted-but-still-pending.
            await recordFailure(db, mutation.id, errorMessage);
            // The row may have just flipped to dead_letter; refresh the pending
            // badges either way (an extra COUNT requery is harmless).
            invalidateForTable(queryClient, mutation.table_name);
            retryableHit = true;
            break;
          } else {
            // Non-retryable (validation / 4xx): retrying can't help, so
            // dead-letter immediately regardless of retry_count.
            await markDeadLetter(db, mutation.id, errorMessage);
            invalidateForTable(queryClient, mutation.table_name);
          }
        }
      }

      // Connectivity is gone — end the cycle; the reconnect trigger drains again.
      if (networkStop) break;

      if (retryableHit) {
        // Give up this cycle once the in-cycle attempt budget is spent; the next
        // external trigger (or the scheduler's own retrigger) starts fresh.
        if (retryAttempts >= maxCycleAttempts) break;
        // Lifecycle/connectivity may change after the failed request but before
        // backoff starts. Avoid sleeping when this cycle can no longer retry.
        if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded || !options.isOnline()) break;
        await sleep(backoffDelay(retryAttempts, baseDelayMs, maxDelayMs));
        retryAttempts += 1;
        // The app may sign out, background, or lose connectivity during the
        // sleep. Re-check before touching SQLite or sending the mutation again.
        if (_isSigningOut || _wipeEpoch !== startEpoch || _isBackgrounded || !options.isOnline()) break;
        continue;
      }

      // Whole batch succeeded (or only dead-lettered non-retryables); reset the
      // backoff budget so transient failures later don't inherit a high count.
      retryAttempts = 0;
    }
  } finally {
    _isDraining = false;
  }
}

export function isDraining(): boolean {
  return _isDraining;
}

export function __resetDrainerStateForTests(): void {
  _isDraining = false;
  _isSigningOut = false;
  _isBackgrounded = false;
  // Epoch checks are relative (capture-then-compare), so a residual value is
  // technically harmless — reset anyway so no test inherits another's wipes.
  _wipeEpoch = 0;
}
