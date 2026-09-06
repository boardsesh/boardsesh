import type { OfflineDatabase, QueryInvalidator } from '../database';
import type { GraphQLFetch } from './handlers';
import { processMutation } from './handlers';
import { peekPending, markCompleted, recordFailure, markDeadLetter } from './queue';
import {
  isGraphQLEmptyResponseError,
  isRetryable,
  isNetworkError,
  isServerUnavailableError,
  isServerFailureSignal,
  getErrorStatus,
} from './error-classification';
import { invalidateKeysForTable } from '../sync/invalidate-keys';
import { parseQueueTimestamp } from './queue-timestamps';

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

// Monotonic GLOBAL wipe generation. The boolean above is true only for the
// milliseconds clearUserData takes, so an async operation whose network await
// was in flight during that window sees `false` on both sides of it and would
// happily write the old user's data back after the wipe (or, in a drain, post
// the old user's queued writes under the NEXT user's token). Long-running
// operations capture the epoch at start and abort when it has moved.
//
// GLOBAL means "nothing local survives this": sign-out, the owner-stamp
// mismatch wipe, and the manual database compaction. Removing ONE board's
// catalog bumps a per-namespace epoch instead (see beginScopePurge) so it stops
// only the work it can actually invalidate (issue #4370).
let _globalWipeEpoch = 0;

/**
 * Per-namespace purge generation, keyed by `purgeNamespaceKey(scope)` —
 * `boardType:layoutId`, exactly removeBoardScopeData's DELETE predicate. A
 * namespace absent from the map has never been purged this app session.
 */
const _purgeEpochs = new Map<string, number>();

/**
 * Namespaces whose delete transaction is running RIGHT NOW, refcounted so two
 * removals of the same layout (Remove-all iterating two sizes) cannot unlatch
 * each other. removeBoardScopeData holds an exclusive transaction for seconds
 * on a 40k-climb layout; the epoch alone only tells a check "a purge happened",
 * while this tells it "a purge is in progress", which is what keeps a marker
 * write from being dispatched INTO the delete window.
 */
const _purgesInFlight = new Map<string, number>();

/**
 * What a long-running operation captures once, at its start, to detect a purge
 * that landed while it was awaiting.
 */
export type PurgeToken = {
  readonly global: number;
  /** A COPY of every namespace epoch known at capture time. */
  readonly namespaces: ReadonlyMap<string, number>;
};

/**
 * Capture once, at the start of a long-running operation; never re-capture
 * mid-flight. Re-capturing would re-baseline against a purge that has already
 * landed and let the operation carry on writing rows that are being deleted.
 *
 * Takes no argument list and copies the whole map deliberately, which makes
 * `hasPurgeLanded` total: a namespace never purged reads `0 !== 0`, one purged
 * before capture reads `n !== n`, one purged after capture reads `n !== n+1`.
 * There is no "did you remember to register this namespace" footgun. The map
 * holds at most one entry per layout the user removed this app session.
 */
export function capturePurgeToken(): PurgeToken {
  return { global: _globalWipeEpoch, namespaces: new Map(_purgeEpochs) };
}

/**
 * Has a purge that could touch `namespace` landed since the token was captured?
 *
 * Omit `namespace` for work no board purge can invalidate — the user tables, the
 * mutation outbox, the global deletions cursor — and only the global epoch
 * counts. A board-scoped caller that forgets the argument degrades to
 * global-only (i.e. it does not abort), so derive the namespace in ONE place per
 * call path rather than at every check site.
 */
export function hasPurgeLanded(token: PurgeToken, namespace?: string): boolean {
  if (token.global !== _globalWipeEpoch) return true;
  if (namespace === undefined) return false;
  if (_purgesInFlight.has(namespace)) return true;
  return (token.namespaces.get(namespace) ?? 0) !== (_purgeEpochs.get(namespace) ?? 0);
}

/**
 * Fired the instant a teardown transition happens — sign-out starts, a local
 * purge bumps the epoch, or the app goes to background.
 *
 * Everything else in the engine POLLS the three guards below across its awaits,
 * which is enough for a loop that keeps reaching one. A single native artifact
 * download does not: it can sit for minutes inside one `await` with no progress
 * event to poll from (a stalled connection sends nothing), so the transfer would
 * keep running over a metered link long after the cycle was torn down. Those
 * callers subscribe instead of polling. Listeners must never throw and must
 * never assume they run once — a listener that reads the guards itself gets the
 * truth regardless of which transition woke it.
 */
const teardownListeners = new Set<() => void>();

export function onTeardown(listener: () => void): () => void {
  teardownListeners.add(listener);
  return () => {
    teardownListeners.delete(listener);
  };
}

function notifyTeardown(): void {
  // Snapshot first: a listener that unsubscribes itself must not mutate the set
  // being iterated.
  for (const listener of [...teardownListeners]) {
    try {
      listener();
    } catch {
      // A broken listener must never stop sign-out, a purge, or backgrounding.
    }
  }
}

export function setSigningOut(value: boolean): void {
  if (value && !_isSigningOut) _globalWipeEpoch += 1;
  _isSigningOut = value;
  if (value) notifyTeardown();
}

/**
 * Purge ONE board namespace — removing a downloaded catalog (issues #3617,
 * #4370).
 *
 * The hazard is the one sign-out has: a pull page already on the wire lands
 * after the delete and resurrects part of the catalog, complete with a
 * checkpoint past it, which the strict `>` delta pull then never revisits. Every
 * long-running pull path re-checks across its awaits (syncTable checks at each
 * page top AND again right after the fetch await, before upsertDocuments — that
 * second check is the one that discards the in-flight page), so bumping an epoch
 * reuses those guards rather than inventing a second mechanism.
 *
 * The epoch is PER NAMESPACE because removeBoardScopeData's blast radius is:
 * `board_type = ? AND layout_id = ?` and nothing else. Bumping a global counter
 * for it aborted every other board's download, the mutation-queue drain, the
 * user-data pull and the deletions pull — a Remove tap cost the whole engine a
 * cycle (#4370).
 *
 * Deliberately not setSigningOut(true): that also flips _isSigningOut, which
 * halts drainMutationQueue (the user's unsynced ticks have nothing to do with a
 * board catalog) and would need a paired setSigningOut(false) that races a real
 * concurrent sign-out and clears ITS flag.
 *
 * Returns the latch release. Call it from a `finally`, never conditionally: the
 * epoch bump alone leaves a window where a check made INSIDE the seconds-long
 * delete transaction reads "no purge" unless the bump happened to precede it,
 * and that is exactly the window a `scope-complete:` marker write must not be
 * dispatched into. The release is idempotent, so a double call cannot unlatch a
 * second concurrent purge of the same namespace.
 */
export function beginScopePurge(namespace: string): () => void {
  _purgeEpochs.set(namespace, (_purgeEpochs.get(namespace) ?? 0) + 1);
  _purgesInFlight.set(namespace, (_purgesInFlight.get(namespace) ?? 0) + 1);
  notifyTeardown();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const inFlight = _purgesInFlight.get(namespace) ?? 0;
    if (inFlight <= 1) {
      _purgesInFlight.delete(namespace);
      notifyPurgeSettled(namespace);
    } else _purgesInFlight.set(namespace, inFlight - 1);
  };
}

/**
 * This namespace's purge generation. Read by the download funnel's terminal
 * bookkeeping (issue #4406) so a removal and the cycle it tore down can tell
 * they are talking about the SAME removal: both read the epoch the purge bumped,
 * so the teardown's abandoned terminal and the pull client's own `aborted-wipe`
 * terminal can never double up, while a LATER removal of the same scope reads a
 * different epoch and reports its own.
 */
export function getPurgeEpoch(namespace: string): number {
  return _purgeEpochs.get(namespace) ?? 0;
}

/**
 * Fired when a namespace's LAST in-flight purge releases — the delete
 * transaction has committed and work for that namespace is allowed again.
 *
 * The mirror image of `onTeardown`, and the reason it exists (issue #4406): a
 * sync cycle that runs while the latch is set reads "purged" at every guard and
 * skips the scope from top to bottom, reporting nothing. That is correct — but
 * the trigger that kicked it is spent, and the scheduler has no interval, so a
 * board switched back on DURING a removal sat on "waiting to download"
 * indefinitely. Listeners must never throw.
 */
const purgeSettledListeners = new Set<(namespace: string) => void>();

export function onPurgeSettled(listener: (namespace: string) => void): () => void {
  purgeSettledListeners.add(listener);
  return () => {
    purgeSettledListeners.delete(listener);
  };
}

function notifyPurgeSettled(namespace: string): void {
  // Snapshot first, same as notifyTeardown: a listener that unsubscribes itself
  // must not mutate the set being iterated.
  for (const listener of [...purgeSettledListeners]) {
    try {
      listener(namespace);
    } catch {
      // A broken listener must never break a removal's release path.
    }
  }
}

/**
 * Bump the GLOBAL epoch: a wipe that is not scoped to one board, so every
 * in-flight operation must bail whatever it is working on. Two callers — the
 * owner-stamp mismatch wipe, and compactOfflineDatabase before a VACUUM (an
 * exclusive lock held for 5-20s, which a concurrent import would meet as
 * SQLITE_BUSY and charge itself a structural failure for). Sign-out bumps the
 * same epoch through setSigningOut rather than calling this.
 *
 * There is no endGlobalPurge: the epoch is monotonic, so there's no flag to
 * unset, nothing to leak, and no cleanup a throw could skip. In-flight cycles
 * captured the old value and bail; the next cycle captures the new one.
 */
export function beginGlobalPurge(): void {
  _globalWipeEpoch += 1;
  notifyTeardown();
}

// Read by the pull client too: an in-flight pullSync page must stop writing the
// old user's rows once sign-out starts wiping — otherwise a page landing after
// clearUserData resurrects data the next signed-in account could briefly see.
export function isSigningOut(): boolean {
  return _isSigningOut;
}

/** The GLOBAL epoch only — a board purge never moves it. See beginGlobalPurge. */
export function getWipeEpoch(): number {
  return _globalWipeEpoch;
}

// Backgrounding guard (Sentry BOARDSESH-AN), same shape as the sign-out guard above.
let _isBackgrounded = false;

export function setBackgrounded(value: boolean): void {
  const wasBackgrounded = _isBackgrounded;
  _isBackgrounded = value;
  if (value && !wasBackgrounded) notifyTeardown();
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

// Intentionally mirrored by OfflineMutationDelivery in @boardsesh/board-react.
// The dependency boundary prevents either package importing the other; keep
// both event contracts in sync when fields change.
export type MutationDeliveryEvent = {
  tableName: string;
  operation: string;
  idempotencyKey: string;
  status: 'acknowledged' | 'dead_letter';
};

export type MutationStatusListenerFailure = {
  error: unknown;
  event: MutationDeliveryEvent;
};

/**
 * A queued user write that will never reach the server. Deliberately NOT folded
 * into MutationDeliveryEvent: that type is mirrored field-for-field by
 * OfflineMutationDelivery in @boardsesh/board-react (see the note above it), so
 * widening it forces a lockstep edit in a second package for data no UI
 * consumer wants. A separate seam matches the engine's other telemetry hooks
 * (onSchemaDrift, onCoverageReset, onScopeDownloadComplete).
 *
 * A dead letter is by construction NOT a connectivity problem — a network error
 * takes the networkStop branch without burning retry_count — so every one of
 * these is a permanent loss of something the user did.
 */
export type MutationDeadLetterInfo = {
  tableName: string;
  operation: string;
  /** Raw entity uuid or a deterministic key; keep it out of analytics props. */
  idempotencyKey: string;
  /** `retries_exhausted` burned the whole budget; `non_retryable` was a 4xx. */
  reason: 'retries_exhausted' | 'non_retryable';
  retryCount: number;
  maxRetries: number;
  /** How long the write sat in the outbox before it was given up on. */
  queuedForMs: number | null;
  /** Resolved HTTP / GraphQL status, when the failure carried one. */
  status: number | null;
  errorMessage: string;
  /** The original throw, so the platform reporter can attach it as `cause`. */
  error: unknown;
};

export type MutationDeadLetterReporter = (info: MutationDeadLetterInfo) => void;

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
  /**
   * Called when a mutation fails with a server-side failure signal (5xx or the
   * masked INTERNAL_SERVER_ERROR shape the backend serves over HTTP 200).
   * Resolve `true` when the server is known usable — charge the mutation as
   * today. Resolve `false` to end the cycle as a network stop without charging
   * it: the failure was about the server, not this write, and every remaining
   * queued write would have burned a retry for the same outage. The mobile
   * adapter binds this to its deduped `/health/db` probe. Optional: without it
   * the drain keeps its existing behaviour and charges the retry.
   */
  confirmServerAvailability?: () => Promise<boolean>;
  /**
   * Delivery seam for optimistic UI that must distinguish a durable local
   * enqueue from server acknowledgement or permanent rejection. The
   * idempotency key is the entity UUID for tick creates.
   */
  onMutationStatus?: (event: MutationDeliveryEvent) => void;
  /** Platform-owned telemetry for a throwing delivery callback. */
  onMutationStatusError?: (failure: MutationStatusListenerFailure) => void;
  /**
   * Telemetry seam for a permanently lost write. Fires once per row that
   * reaches dead_letter, from BOTH the exhausted-retries and non-retryable
   * branches. Failure-isolated like onMutationStatus: a throwing reporter can
   * never abort a drain or prevent the dead-letter write committing.
   */
  onMutationDeadLettered?: MutationDeadLetterReporter;
};

function notifyMutationStatus(options: DrainOptions, event: MutationDeliveryEvent): void {
  try {
    options.onMutationStatus?.(event);
  } catch (error) {
    try {
      options.onMutationStatusError?.({ error, event });
    } catch (reportingError) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[MutationQueue] mutation-status error reporter failed:', reportingError);
      }
    }
    if (!options.onMutationStatusError && process.env.NODE_ENV !== 'production') {
      console.warn('[MutationQueue] mutation-status listener failed:', error);
    }
  }
}

function notifyDeadLetter(options: DrainOptions, info: MutationDeadLetterInfo): void {
  try {
    options.onMutationDeadLettered?.(info);
  } catch (reportingError) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[MutationQueue] dead-letter reporter failed:', reportingError);
    }
  }
}

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
  const keys = invalidateKeysForTable(tableName);
  if (!keys) {
    // table_name is a plain string, so a NEW mutation type missing from the
    // map compiles fine and drains fine — but its UI would never refresh.
    // Surface the gap loudly in dev instead of silently skipping. (NODE_ENV is
    // the platform-free stand-in for RN's __DEV__ — Metro inlines it the same
    // way, and this package has no react-native globals.) An entry that is
    // present but EMPTY is a deliberate "nothing reads this yet", not a gap.
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

/** How long a row sat in the outbox, or null when created_at won't parse. */
function queuedForMs(createdAt: string): number | null {
  const queuedAt = parseQueueTimestamp(createdAt);
  return queuedAt === null ? null : Math.max(0, Date.now() - queuedAt);
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
  // "Offline" here is wider than "no radio": the mobile connectivity store writes
  // React Query's onlineManager from backend reachability too, so a live device
  // pointed at a backend that is down reads as offline. This gate and the
  // in-cycle re-checks below therefore stop a drain for the whole of a KNOWN
  // outage; `confirmServerAvailability` covers the one failure that DISCOVERS
  // an outage, before the store has learned about it (#4862).
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
  const startEpoch = _globalWipeEpoch;

  try {
    while (true) {
      if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded) break;
      const batch = await peekPending(db, 10);
      if (batch.length === 0) break;

      let retryableHit = false;
      let networkStop = false;

      for (const mutation of batch) {
        if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded) {
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
          if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded) {
            networkStop = true; // reuse the "end cycle now" path
            break;
          }
          await markCompleted(db, mutation.id);
          invalidateForTable(queryClient, mutation.table_name);
          notifyMutationStatus(options, {
            tableName: mutation.table_name,
            operation: mutation.operation,
            idempotencyKey: mutation.idempotency_key,
            status: 'acknowledged',
          });
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

          if (isServerUnavailableError(error)) {
            // 502/503/504 is an edge or upstream verdict — a gateway, a proxy,
            // or a backend not accepting work — not a verdict on THIS mutation.
            // Charging it a strike would spend the retry budget of every queued
            // write on one outage, so end the cycle the way a dropped connection
            // does and let the next trigger try again (#4862).
            networkStop = true;
            break;
          }

          if (isServerFailureSignal(error) && options.confirmServerAvailability) {
            // A 5xx, or the masked INTERNAL_SERVER_ERROR the backend serves over
            // HTTP 200 during a database outage, is ambiguous: either this one
            // resolver broke, or the server is unusable for everything behind it.
            // Only the platform can tell — ask its health probe before deciding
            // whether this write deserves a strike.
            // A probe that cannot even complete during an outage is the most
            // likely outcome, and it is the same evidence as a `false`: the
            // server is unreachable. Letting it reject here would escape the
            // whole drain and turn a routine outage into a cycle error.
            let serverAvailable = false;
            try {
              serverAvailable = await options.confirmServerAvailability();
            } catch {
              serverAvailable = false;
            }
            if (!serverAvailable) {
              // The server is down, not the write. Leave the row pending and
              // unstruck; the drain resumes when the probe says it is back.
              networkStop = true;
              break;
            }
          }

          // Same re-check as the success path above, before the retry/dead-letter
          // bookkeeping writes below. It also covers the availability probe's
          // await just above: sign-out, a wipe, or backgrounding may have started
          // while that probe was in flight, and its bookkeeping writes must not
          // land either.
          if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded) {
            networkStop = true;
            break;
          }

          if (isRetryable(error)) {
            // One atomic UPDATE bumps the retry and, when the bumped count hits
            // max_retries, flips to dead_letter — no window where the row is
            // exhausted-but-still-pending.
            const { status, retryCount } = await recordFailure(db, mutation.id, errorMessage);
            // The row may have just flipped to dead_letter; refresh the pending
            // badges either way (an extra COUNT requery is harmless).
            invalidateForTable(queryClient, mutation.table_name);
            if (status === 'dead_letter') {
              notifyMutationStatus(options, {
                tableName: mutation.table_name,
                operation: mutation.operation,
                idempotencyKey: mutation.idempotency_key,
                status,
              });
              notifyDeadLetter(options, {
                tableName: mutation.table_name,
                operation: mutation.operation,
                idempotencyKey: mutation.idempotency_key,
                reason: 'retries_exhausted',
                retryCount,
                maxRetries: mutation.max_retries,
                queuedForMs: queuedForMs(mutation.created_at),
                status: getErrorStatus(error),
                errorMessage,
                error,
              });
            }
            retryableHit = true;
            break;
          } else {
            // Non-retryable (validation / 4xx): retrying can't help, so
            // dead-letter immediately regardless of retry_count.
            await markDeadLetter(db, mutation.id, errorMessage);
            invalidateForTable(queryClient, mutation.table_name);
            notifyMutationStatus(options, {
              tableName: mutation.table_name,
              operation: mutation.operation,
              idempotencyKey: mutation.idempotency_key,
              status: 'dead_letter',
            });
            notifyDeadLetter(options, {
              tableName: mutation.table_name,
              operation: mutation.operation,
              idempotencyKey: mutation.idempotency_key,
              reason: 'non_retryable',
              retryCount: mutation.retry_count,
              maxRetries: mutation.max_retries,
              queuedForMs: queuedForMs(mutation.created_at),
              status: getErrorStatus(error),
              errorMessage,
              error,
            });
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
        if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded || !options.isOnline()) break;
        await sleep(backoffDelay(retryAttempts, baseDelayMs, maxDelayMs));
        retryAttempts += 1;
        // The app may sign out, background, or lose connectivity during the
        // sleep. Re-check before touching SQLite or sending the mutation again.
        if (_isSigningOut || _globalWipeEpoch !== startEpoch || _isBackgrounded || !options.isOnline()) break;
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
  _globalWipeEpoch = 0;
  _purgeEpochs.clear();
  // A leaked latch would block that namespace's work for every later test.
  _purgesInFlight.clear();
  // A listener leaked by an aborted run would otherwise fire into the next test.
  teardownListeners.clear();
  purgeSettledListeners.clear();
}
