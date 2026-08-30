// Snapshot-bootstrap retry accounting (issue #4313).
//
// The problem this replaces: `MAX_BOOTSTRAP_ATTEMPTS = 2` was doing two jobs at
// once. It stood in for retry frequency even though the artifact GET is
// unresumable, AND for the total-spend bound (a ~103 MB download must not restart
// on every foreground). Because a dropped connection at the DOWNLOAD
// stage burned the same counter as a corrupt artifact, two flaky-network launches
// condemned a board to the 400+-round-trip paged crawl for the life of the
// install — 123 Sentry events across 75 users in 60 days.
//
// The split made here: every failure gets a KIND, each kind has its own lifetime
// budget, and frequency is bounded separately by a persisted cooldown ladder.
//
//   transport           network/DNS/TLS/timeout at the download stage. Never
//                       touches the structural budget. 3 consecutive failures,
//                       reset to 0 by any successful download. (The MANIFEST
//                       stage stays entirely free — a few KB of JSON, and it is
//                       where an offline launch dies. Issue #4238.) A transfer
//                       the OS killed by suspending us is free for its first
//                       three tries and charged here after that — see
//                       `recordBackgroundPause` (issue #4390).
//   database-locked     the import lost the SQLite write lock (issue #4310).
//                       Its own budget, because it belongs to neither of the
//                       others: nothing about a lost race says the artifact is
//                       bad, and nothing about it says the network is. Crucially
//                       it is NOT the transport budget, which any successful
//                       download clears — and a RETAINED artifact "downloads"
//                       by handing back a file already on disk, moving zero
//                       bytes, so a transport-charged lock failure could be
//                       reset every cycle and never terminate. 3 failures on
//                       the transport ladder's cooldowns, then the scope settles
//                       onto the paged crawl. Never re-armed by a new `builtAt`:
//                       tonight's export cannot win a lock race either.
//   structural-artifact the bytes are on disk and provably bad (quick_check,
//                       snapshot_meta mismatch, import throw). Tonight's export
//                       might fix it, so a NEW `builtAt` may re-arm the budget —
//                       once per scope, ever.
//   structural-device   everything else non-transport (disk full, cache dir,
//                       CDN non-2xx, unclassifiable). Burns the structural
//                       budget and NEVER re-arms on `builtAt`: the export is
//                       nightly, so a `builtAt` reset for a device-side fault
//                       would be 2 x 103 MB every day, forever.
//
// Worst-case lifetime artifact downloads per scope: 3 (transport) + 2
// (structural) + 2 (the one re-armed structural round) = 7, each separated by at
// least one cooldown rung. `database-locked` adds no downloads at all — it fires
// on bytes already on disk, and the retained-artifact path does not delete
// them. `snapshot-bootstrap.test.ts` pins that number so any future loosening
// shows up in a diff.
//
// ROLLBACK SAFETY. `bootstrap-retry:<scopeKey>` is the source of truth, but every
// write ALSO mirrors the legacy `bootstrap-attempts:` / `-healed:` /
// `-paged-fallback:` rows, and they are never deleted. Production channel
// rollback and `pr-<n>` preview channels are live paths here: an older bundle
// that reads no legacy row would re-arm a fresh 2-attempt round plus another
// one-shot heal. Reads reconcile in the other direction — if the legacy counter
// moved past what we last mirrored, an older bundle counted something real and
// those failures are folded back in.
//
// Pure except for the two SqlExecutor helpers at the bottom: no clock, no RNG,
// no I/O inside the decision functions. `now` and `random` are always injected.

import type { OfflineDatabase, SqlExecutor } from '../database';
import { isNetworkError } from '../mutation-queue/error-classification';
import { classifySqliteLockError } from '../db/lock-errors';

// --- sync_meta keys -----------------------------------------------------------
//
// Package-internal (deliberately NOT re-exported from index.ts, same posture as
// checkpoints.ts's DELETIONS_CHECKPOINT_KEY): scope-teardown.ts must clear these
// alongside the rows they describe, so it needs the exact key spelling. They live
// here rather than in snapshot-bootstrap.ts because the retry row and its legacy
// mirrors are written together, by one function, and a cycle between the two
// modules would leave `BOOTSTRAP_METADATA_PATTERNS` reading `undefined` at import
// time.

export const BOOTSTRAP_ATTEMPTS_PREFIX = 'bootstrap-attempts:';
/** "This scope has already spent its one free counter reset" (legacy, #4238). */
export const BOOTSTRAP_ATTEMPTS_HEALED_PREFIX = 'bootstrap-attempts-healed:';
export const BOOTSTRAP_PAGED_FALLBACK_PREFIX = 'bootstrap-paged-fallback:';
/** The retry row this module owns: one JSON `BootstrapRetryState` per scope. */
export const BOOTSTRAP_RETRY_PREFIX = 'bootstrap-retry:';

// --- Budgets and ladders ------------------------------------------------------

/**
 * Structural failures (artifact- or device-side) a scope may spend before it
 * settles onto the paged crawl. Unchanged in value from the pre-#4313 cap, but
 * narrowed in meaning: transport failures no longer touch it.
 */
export const MAX_BOOTSTRAP_ATTEMPTS = 2;

/**
 * Consecutive download-stage transport failures before a scope settles. Bounds
 * total spend on a device where the unresumable GET can never complete — the
 * cooldown alone only bounds frequency.
 */
export const MAX_TRANSPORT_DOWNLOAD_FAILURES = 3;

/**
 * Lock-contention import failures a scope may spend before it settles onto the
 * paged crawl (issue #4310).
 *
 * This budget exists because neither of the other two can hold a lock failure
 * safely. `structural-artifact` strands the scope after TWO strikes and deletes
 * the ~103 MB file on the retained-artifact path, for a failure the artifact did
 * not cause. `transport` is worse in the other direction: `clearTransportFailures`
 * resets it after any successful download, and a RETAINED artifact is handed back
 * off disk with zero bytes moved — so a device with persistent write-lock
 * contention would charge 1, get reset, charge 1, get reset, forever, never
 * reaching the cap that lets `shouldSkipPagedPull` fall through to the crawl. The
 * board would then be unreachable by BOTH paths, which is strictly worse than the
 * pre-batching behaviour this escape was added to fix.
 *
 * 3 rather than 2: contention is transient by nature, and the cooldown ladder
 * below already spaces the tries out. When it is spent the scope is terminal, so
 * the paged crawl runs — the board still becomes available offline, just slowly.
 */
export const MAX_BOOTSTRAP_LOCK_FAILURES = 3;

/**
 * Consecutive download-stage backgrounding pauses a scope gets for free before
 * the transport ladder takes over (issue #4390).
 *
 * A pocketed phone is not a broken device, so a transfer the OS suspended must
 * not burn an attempt or schedule a cooldown. Four in a row with zero bytes
 * retained is a different thing: it is a device that cannot finish a ~100 MB
 * unresumable GET, and leaving it uncharged would re-fetch the whole artifact on
 * every foreground, forever, straight past the 3-strikes ladder that exists to
 * stop exactly that.
 */
export const MAX_FREE_BACKGROUND_PAUSES = 3;

/** Lifetime re-arms of the structural budget on a newly built artifact. */
export const MAX_STRUCTURAL_REARMS = 1;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Cooldown after the 1st, 2nd, 3rd… consecutive transport failure. */
const TRANSPORT_COOLDOWNS_MS = [2 * MINUTE_MS, 15 * MINUTE_MS, 2 * HOUR_MS] as const;
/**
 * Cooldown after the 1st, 2nd, 3rd lock-contention import failure. The transport
 * rungs, deliberately: the contending writer — a tick, a favourite, another
 * layout's `removeBoardScopeData` — is finished in seconds to minutes, so a short
 * first retry is the one most likely to succeed, and the third rung is moot
 * because the third failure is terminal.
 */
const LOCK_COOLDOWNS_MS = TRANSPORT_COOLDOWNS_MS;
/** Cooldown after the 1st, 2nd… structural failure. */
const STRUCTURAL_COOLDOWNS_MS = [6 * HOUR_MS, 24 * HOUR_MS] as const;

/**
 * How close a scheduled retry must be before a FRESH scope skips its paged crawl
 * to wait for it. Beyond this the crawl runs, so a board is never left empty
 * waiting on a 2-hour cooldown — it just doesn't spend 400 round trips when an
 * artifact is two minutes away.
 */
export const BOOTSTRAP_RETRY_GRACE_WINDOW_MS = 30 * MINUTE_MS;

/** How long an automatic heal defers itself when the link is metered. */
export const METERED_HEAL_DEFERRAL_MS = 6 * HOUR_MS;

/** Spread the post-OTA migration wave for scopes that already hold rows. */
const LEGACY_MIGRATION_SPREAD_MS = 2 * HOUR_MS;

// --- State --------------------------------------------------------------------

export type BootstrapFailureKind = 'transport' | 'database-locked' | 'structural-artifact' | 'structural-device';

export type BootstrapRetryState = {
  /** Consecutive download-stage transport failures; any success resets it to 0. */
  readonly transportFailures: number;
  /**
   * Consecutive download-stage backgrounding pauses since the last completed
   * download. Free up to `MAX_FREE_BACKGROUND_PAUSES`, then charged as
   * `transport` on its ladder; `clearTransportFailures` resets it, because a
   * download that finished proves the device can finish one.
   */
  readonly backgroundPauses: number;
  /**
   * Lock-contention import failures spent (issue #4310). Deliberately NOT
   * touched by `clearTransportFailures`: a retained artifact is handed back off
   * disk with zero bytes moved, so a "successful download" demonstrates nothing
   * about whether the import can win the write lock. Nothing but the climber's
   * explicit retry clears it — a completed import ends bootstrapping for the
   * scope outright, so there is no success to reset it against.
   */
  readonly lockFailures: number;
  /** Structural failures spent from the current (possibly re-armed) budget. */
  readonly structuralFailures: number;
  /** Structural budgets granted by a newly built artifact, lifetime. */
  readonly structuralRearms: number;
  readonly lastFailureKind: BootstrapFailureKind | null;
  /** `builtAt` of the artifact the last structural failure was raised against. */
  readonly failedBuiltAt: string | null;
  /** Epoch ms before which this scope is not bootstrap-eligible. */
  readonly retryAfter: number | null;
  /**
   * Whether this scope has ever failed on the snapshot path. Retained for
   * recovery attribution and compatibility with older bundles; incomplete
   * checkpointed scopes are now heal-eligible even without failure history.
   */
  readonly hasPriorSnapshotFailure: boolean;
  /**
   * The climber tapped "Try the fast download again" and has not been served
   * yet. Worth one consented artifact download: it overrides the metered-link
   * defer — they confirmed the size on that exact screen moments ago — and is
   * spent the instant the download starts, so a failure does not hand the
   * engine a standing licence to keep pulling ~100 MB over cellular.
   */
  readonly userRequested: boolean;
  /**
   * The value last written to the legacy `bootstrap-attempts:` row. A legacy
   * counter ABOVE this means an older (rolled-back) bundle counted failures we
   * never saw, and the difference is folded into `structuralFailures` on read.
   */
  readonly mirroredAttempts: number;
  /** The legacy one-shot heal is pre-spent, so a rolled-back bundle can't re-grant it. */
  readonly legacyHealSpent: boolean;
};

export const EMPTY_BOOTSTRAP_RETRY_STATE: BootstrapRetryState = {
  transportFailures: 0,
  backgroundPauses: 0,
  lockFailures: 0,
  structuralFailures: 0,
  structuralRearms: 0,
  lastFailureKind: null,
  failedBuiltAt: null,
  retryAfter: null,
  hasPriorSnapshotFailure: false,
  userRequested: false,
  mirroredAttempts: 0,
  legacyHealSpent: false,
};

// --- Pure decisions -----------------------------------------------------------

/**
 * Which budget a failure spends. Import-stage failures are `structural-artifact`
 * unless they are lock contention: the bytes are already on disk, so nothing
 * about them is a network problem, and a rebuilt artifact is the one thing that
 * could fix it. Anything else transport-shaped (`isNetworkError`, the same
 * predicate the mutation drainer uses to keep a mutation off the dead-letter
 * path) is `transport`; everything remaining is attributed to the device, which
 * is the conservative default because a plain `Error` from an adapter's
 * downloader cannot be told apart from a disk-full or cache-dir fault.
 *
 * THE LOCK ESCAPE (issue #4310). A "database is locked" says nothing about the
 * artifact — a rebuilt one would lose the same race. Before
 * batching that barely mattered: the import took the lock once, for the whole
 * import. Now it takes it once per batch (~143 times for a Kilter layout)
 * against writers that genuinely exist, including a `removeBoardScopeData` for a
 * DIFFERENT layout that runs longer than the import connection's busy_timeout.
 * Charging those to the structural budget would strand a board on the paged
 * crawl after two lost races — `MAX_BOOTSTRAP_ATTEMPTS` is 2 and there is at
 * most one lifetime re-arm — which remove-offline-board.ts already documents as
 * a live hazard for VACUUM.
 *
 * It gets its OWN budget rather than riding `transport`, because `transport` is
 * cleared by any successful download and a RETAINED artifact "succeeds" by
 * handing back a file already on disk with zero bytes moved. On the transport
 * budget, persistent contention would charge 1, get reset by the next cycle's
 * reuse, charge 1 again, and never reach the cap — while `shouldSkipPagedPull`
 * kept skipping the crawl on the ~2-minute cooldown, leaving the board
 * unreachable by both paths forever. See `MAX_BOOTSTRAP_LOCK_FAILURES`.
 *
 * DELIBERATELY NOT GATED ON `stage === 'import'`, even though the import is the
 * only stage that takes a write lock today. The bucket is named by CAUSE, not by
 * stage, and the fallthrough for an ungated lock error is `structural-device` —
 * the harshest bucket there is: two strikes, never re-armed by a new `builtAt`.
 * Charging transient contention there would be strictly worse than charging the
 * lock budget, which costs no downloads and re-tries three times. So if a future
 * change ever does put a write on the manifest or download stage, landing here is
 * the outcome to want, not the one to guard against.
 */
export function classifyBootstrapFailure(input: {
  cause: unknown;
  stage: 'manifest' | 'download' | 'import';
}): BootstrapFailureKind {
  if (classifySqliteLockError(input.cause).locked) return 'database-locked';
  if (input.stage === 'import') return 'structural-artifact';
  // Keep this module dependency-neutral: snapshot-bootstrap imports the retry
  // constants below at module initialization time. The mobile adapter converts
  // iOS's background URLSession decode failure into this stable error name.
  if (input.cause instanceof Error && input.cause.name === 'SnapshotBackgroundTransferInterruptedError') {
    return 'transport';
  }
  // A short body is a cut-short RESPONSE, so it belongs on the transport ladder
  // (3 tries, cleared by any success) rather than `structural-device`, where two
  // occurrences would durably settle the scope onto the paged crawl with no
  // `builtAt` re-arm — far too harsh for what is at least as likely a one-off
  // network fluke as a systematic device fault. Ahead of `isNetworkError`, which
  // does not match it. Issue #4394.
  if (input.cause instanceof Error && input.cause.name === 'SnapshotArtifactTruncatedError') return 'transport';
  if (isNetworkError(input.cause)) return 'transport';
  return 'structural-device';
}

/** Either budget exhausted: the scope has settled onto the paged crawl. */
export function isTerminal(state: BootstrapRetryState): boolean {
  return (
    state.transportFailures >= MAX_TRANSPORT_DOWNLOAD_FAILURES ||
    state.lockFailures >= MAX_BOOTSTRAP_LOCK_FAILURES ||
    state.structuralFailures >= MAX_BOOTSTRAP_ATTEMPTS
  );
}

/**
 * Whether a newly built artifact could still re-arm this terminal scope. True
 * only for a scope whose last failure was attributable to the ARTIFACT and which
 * has a re-arm left — a device-side fault or a spent transport budget is not
 * something tonight's export can fix.
 */
export function canRearmOnNewArtifact(state: BootstrapRetryState): boolean {
  return (
    state.lastFailureKind === 'structural-artifact' &&
    state.structuralFailures >= MAX_BOOTSTRAP_ATTEMPTS &&
    state.transportFailures < MAX_TRANSPORT_DOWNLOAD_FAILURES &&
    // A spent lock budget is not artifact-attributable either: tonight's export
    // cannot win a write-lock race the last one lost (issue #4310).
    state.lockFailures < MAX_BOOTSTRAP_LOCK_FAILURES &&
    state.structuralRearms < MAX_STRUCTURAL_REARMS
  );
}

function jitter(baseMs: number, random: () => number): number {
  // [1x, 1.5x) so a fleet that failed together does not retry together.
  return Math.round(baseMs * (1 + random() * 0.5));
}

function cooldownFor(ladder: readonly number[], failureCount: number, random: () => number): number {
  const rung = Math.min(Math.max(failureCount, 1), ladder.length) - 1;
  return jitter(ladder[rung], random);
}

/**
 * Fold one failure into the scope's retry state: burn the right budget, and
 * schedule the next attempt on that budget's ladder. Never mutates its input.
 */
export function nextRetryState(input: {
  state: BootstrapRetryState;
  failureKind: BootstrapFailureKind;
  /** `builtAt` of the artifact the failure was raised against, when known. */
  builtAt: string | null;
  now: number;
  random: () => number;
}): BootstrapRetryState {
  const { state, failureKind, builtAt, now, random } = input;

  if (failureKind === 'transport') {
    const transportFailures = state.transportFailures + 1;
    return {
      ...state,
      transportFailures,
      lastFailureKind: 'transport',
      hasPriorSnapshotFailure: true,
      retryAfter: now + cooldownFor(TRANSPORT_COOLDOWNS_MS, transportFailures, random),
    };
  }

  if (failureKind === 'database-locked') {
    const lockFailures = state.lockFailures + 1;
    return {
      ...state,
      lockFailures,
      lastFailureKind: 'database-locked',
      hasPriorSnapshotFailure: true,
      retryAfter: now + cooldownFor(LOCK_COOLDOWNS_MS, lockFailures, random),
    };
  }

  const structuralFailures = state.structuralFailures + 1;
  return {
    ...state,
    structuralFailures,
    lastFailureKind: failureKind,
    failedBuiltAt: builtAt ?? state.failedBuiltAt,
    hasPriorSnapshotFailure: true,
    retryAfter: now + cooldownFor(STRUCTURAL_COOLDOWNS_MS, structuralFailures, random),
  };
}

/**
 * Grant a terminal, artifact-attributable scope one more structural round
 * because a differently-built artifact is now on offer. Spends a lifetime re-arm.
 */
export function rearmForNewArtifact(state: BootstrapRetryState, builtAt: string): BootstrapRetryState {
  return {
    ...state,
    structuralFailures: 0,
    structuralRearms: state.structuralRearms + 1,
    failedBuiltAt: builtAt,
    retryAfter: null,
  };
}

/**
 * Fold one download-stage backgrounding pause into the scope's retry state.
 *
 * The first `MAX_FREE_BACKGROUND_PAUSES` cost nothing at all — no attempt, no
 * cooldown, no budget — and only advance the counter. The next one is charged to
 * the TRANSPORT budget on its ladder, which is precisely what that budget is
 * for: bounding total spend on a device where the unresumable GET never
 * completes. The counter resets as it charges, so the pattern that terminates is
 * 3 free + 3 transport, after which the scope settles onto the paged crawl and
 * "Try the fast download again" is the consented escape.
 */
export function recordBackgroundPause(input: {
  state: BootstrapRetryState;
  /** `builtAt` of the artifact the pause happened against, when known. */
  builtAt: string | null;
  now: number;
  random: () => number;
}): { state: BootstrapRetryState; charged: boolean } {
  const backgroundPauses = input.state.backgroundPauses + 1;
  if (backgroundPauses <= MAX_FREE_BACKGROUND_PAUSES) {
    return { state: { ...input.state, backgroundPauses }, charged: false };
  }
  return {
    state: nextRetryState({
      state: { ...input.state, backgroundPauses: 0 },
      failureKind: 'transport',
      builtAt: input.builtAt,
      now: input.now,
      random: input.random,
    }),
    charged: true,
  };
}

/**
 * A successful download clears the consecutive-transport counter and its
 * cooldown — and the free-pause counter with them: bytes that landed are proof
 * this device can finish a transfer, whatever happened on the way there.
 *
 * It does NOT clear `lockFailures`, and that omission is the whole point of that
 * counter existing (issue #4310). The caller runs this after every successful
 * download including a RETAINED one, which moves zero bytes — so a reset here
 * would mean a lock-contention failure could never accumulate to its cap, and a
 * fresh scope would sit on a 2-minute cooldown skipping its paged crawl forever.
 */
export function clearTransportFailures(state: BootstrapRetryState): BootstrapRetryState {
  if (state.transportFailures === 0 && state.backgroundPauses === 0 && state.retryAfter === null) return state;
  return { ...state, transportFailures: 0, backgroundPauses: 0, retryAfter: null };
}

/**
 * The user tapped "Try the fast download again". Restores both budgets and drops
 * the cooldown, keeping only the rollback mirrors' bookkeeping. This is the one
 * escape from a terminal scope short of removing and re-adding the board — and
 * it is consented and size-disclosed, which the automatic paths are not.
 */
export function clearRetryStateForUserRequest(state: BootstrapRetryState): BootstrapRetryState {
  return {
    ...EMPTY_BOOTSTRAP_RETRY_STATE,
    // The tap is the consent the automatic heal does not have, so it also
    // overrides the metered-link defer — otherwise the climber confirms ~100 MB
    // on a cellular link and the engine silently sits on it for 6 hours.
    userRequested: true,
    // Keep the failure history for recovery attribution and rollback safety.
    // Checkpointed incomplete scopes are now heal-eligible without this bit, but
    // older bundles still require it after an OTA rollback.
    hasPriorSnapshotFailure: state.hasPriorSnapshotFailure,
    mirroredAttempts: state.mirroredAttempts,
    legacyHealSpent: true,
  };
}

/** Defer an automatic heal without spending anything (metered link). */
export function deferHeal(state: BootstrapRetryState, now: number): BootstrapRetryState {
  return { ...state, retryAfter: now + METERED_HEAL_DEFERRAL_MS };
}

/**
 * Consume the user's retry the moment its download starts. Spending it here
 * rather than on success is deliberate: one tap buys one artifact download, so a
 * failure over cellular schedules an ordinary cooldown instead of leaving a
 * standing metered-link override behind.
 */
export function spendUserRequest(state: BootstrapRetryState): BootstrapRetryState {
  if (!state.userRequested) return state;
  return { ...state, userRequested: false };
}

export type BootstrapEligibility =
  | { eligible: true; kind: 'fresh' | 'heal-over-partial' }
  | {
      eligible: false;
      reason: 'scope-complete' | 'bootstrap-done' | 'terminal' | 'cooling-down';
      /** Only a `terminal` scope can ever be revived by tonight's export. */
      canRearm: boolean;
    };

/**
 * The single authority on "would the snapshot bootstrap run for this scope right
 * now". Called by `runBootstrapPhase` AND by `estimateScopeDownload`, so the size
 * the UI quotes can never disagree with what the engine would do — the two used
 * to be a comment promising they mirrored each other.
 *
 * `heal-over-partial` is the un-strand: any scope that holds a partly-crawled
 * catalog and never finished it may import an artifact over the top. Requiring
 * prior failure metadata made a launch that paged before snapshot I/O became
 * available impossible to heal: page one wrote a checkpoint but no snapshot
 * failure. The caller still restricts automatic heals to unmetered links, and
 * the import refuses to move a checkpoint backwards. A `scope-complete:` scope
 * is NOT healed — it already serves the whole catalog locally.
 */
export function evaluateBootstrapEligibility(input: {
  retryState: BootstrapRetryState;
  hasBoardCheckpoint: boolean;
  isScopeComplete: boolean;
  isBootstrapDone: boolean;
  now: number;
}): BootstrapEligibility {
  const { retryState, hasBoardCheckpoint, isScopeComplete, isBootstrapDone, now } = input;
  if (isScopeComplete) return { eligible: false, reason: 'scope-complete', canRearm: false };
  if (isBootstrapDone) return { eligible: false, reason: 'bootstrap-done', canRearm: false };
  if (isTerminal(retryState)) {
    return { eligible: false, reason: 'terminal', canRearm: canRearmOnNewArtifact(retryState) };
  }
  if (retryState.retryAfter !== null && now < retryState.retryAfter) {
    return { eligible: false, reason: 'cooling-down', canRearm: false };
  }
  if (!hasBoardCheckpoint) return { eligible: true, kind: 'fresh' };
  return { eligible: true, kind: 'heal-over-partial' };
}

/**
 * Whether a scope whose bootstrap did not run this cycle should ALSO skip its
 * paged crawl. Only a fresh scope with an imminent retry does: a first-page
 * checkpoint would (pre-heal-over-partial) have disqualified the snapshot path,
 * and the crawl is 400+ serial round trips it is about to throw away. A scope
 * that already holds rows always crawls — a failed heal must never stall
 * progress that was already being made.
 */
export function shouldSkipPagedPull(input: {
  retryState: BootstrapRetryState;
  hasBoardCheckpoint: boolean;
  now: number;
}): boolean {
  const { retryState, hasBoardCheckpoint, now } = input;
  if (hasBoardCheckpoint) return false;
  if (isTerminal(retryState)) return false;
  if (retryState.retryAfter === null) return true;
  return retryState.retryAfter - now <= BOOTSTRAP_RETRY_GRACE_WINDOW_MS;
}

/**
 * Derive a starting state from the legacy markers an installed app already has.
 *
 * The legacy counter CONFLATED transport failures with real defects — that is the
 * bug — so its value is not carried into `structuralFailures`. A stranded scope
 * gets exactly one clean pass under the new taxonomy (bounded at 3 transport + 2
 * structural), which is what un-strands the mid-crawl population. The legacy rows
 * are never DELETED, but the first `writeBootstrapRetryState` after a migration
 * re-stamps `bootstrap-attempts:` down to the mirrored value — the clean pass has
 * to be visible to a rolled-back bundle too, or it would re-read the pre-migration
 * count and settle the scope again. `mirroredAttempts` records what we wrote, so a
 * later read can tell "an older bundle bumped this" from "this is what we
 * migrated".
 *
 * A scope that already holds rows gets a spread-out `retryAfter` so the whole
 * fleet does not start a 103 MB download on the same post-OTA launch.
 */
export function migrateLegacyBootstrapMarkers(input: {
  legacyAttempts: number;
  legacyHealed: boolean;
  hasBoardCheckpoint: boolean;
  now: number;
  random: () => number;
}): BootstrapRetryState {
  const { legacyAttempts, legacyHealed, hasBoardCheckpoint, now, random } = input;
  const hadFailures = legacyAttempts > 0 || legacyHealed;
  return {
    ...EMPTY_BOOTSTRAP_RETRY_STATE,
    structuralRearms: legacyHealed ? MAX_STRUCTURAL_REARMS : 0,
    hasPriorSnapshotFailure: hadFailures,
    retryAfter: hasBoardCheckpoint && hadFailures ? now + Math.floor(random() * LEGACY_MIGRATION_SPREAD_MS) : null,
    mirroredAttempts: legacyAttempts,
    legacyHealSpent: legacyHealed || legacyAttempts >= MAX_BOOTSTRAP_ATTEMPTS,
  };
}

// --- Persistence --------------------------------------------------------------

type PersistedRetryRow = Partial<Record<keyof BootstrapRetryState, unknown>>;

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Parse one persisted `bootstrap-retry:` row; null when it is missing or corrupt. */
export function parseBootstrapRetryState(raw: string): BootstrapRetryState | null {
  let parsed: PersistedRetryRow;
  try {
    parsed = JSON.parse(raw) as PersistedRetryRow;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const lastFailureKind = parsed.lastFailureKind;
  return {
    transportFailures: readNumber(parsed.transportFailures, 0),
    // Absent on every row written before #4390, and on any row an older bundle
    // rewrote after a rollback: 0 is exactly the pre-#4390 behaviour (unbounded
    // free pauses), not a corruption.
    backgroundPauses: readNumber(parsed.backgroundPauses, 0),
    // Absent on every row written before #4310, and on any row an older bundle
    // rewrote after a rollback. 0 is the pre-#4310 behaviour (the failure was
    // charged structurally instead), not a corruption.
    lockFailures: readNumber(parsed.lockFailures, 0),
    structuralFailures: readNumber(parsed.structuralFailures, 0),
    structuralRearms: readNumber(parsed.structuralRearms, 0),
    lastFailureKind:
      lastFailureKind === 'transport' ||
      lastFailureKind === 'database-locked' ||
      lastFailureKind === 'structural-artifact' ||
      lastFailureKind === 'structural-device'
        ? lastFailureKind
        : null,
    failedBuiltAt: typeof parsed.failedBuiltAt === 'string' ? parsed.failedBuiltAt : null,
    retryAfter: typeof parsed.retryAfter === 'number' && Number.isFinite(parsed.retryAfter) ? parsed.retryAfter : null,
    hasPriorSnapshotFailure: parsed.hasPriorSnapshotFailure === true,
    userRequested: parsed.userRequested === true,
    mirroredAttempts: readNumber(parsed.mirroredAttempts, 0),
    legacyHealSpent: parsed.legacyHealSpent === true,
  };
}

function parseLegacyAttempts(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type BootstrapRetryRead = {
  state: BootstrapRetryState;
  /** This scope had no retry row: the state above was derived from legacy markers. */
  migratedFromLegacy: boolean;
};

/**
 * Read a scope's retry state, deriving it from the legacy markers on first
 * touch. One indexed `sync_meta` lookup for all four keys.
 */
export async function readBootstrapRetryState(
  db: SqlExecutor,
  scopeKey: string,
  clock: { now: number; random: () => number },
  hasBoardCheckpoint: boolean,
): Promise<BootstrapRetryRead> {
  const rows = await db.getAllAsync<{ key: string; value: string }>(
    'SELECT key, value FROM sync_meta WHERE key IN (?, ?, ?)',
    [
      `${BOOTSTRAP_RETRY_PREFIX}${scopeKey}`,
      `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
      `${BOOTSTRAP_ATTEMPTS_HEALED_PREFIX}${scopeKey}`,
    ],
  );
  let retryRow: string | null = null;
  let legacyAttempts = 0;
  let legacyHealed = false;
  for (const row of rows) {
    if (row.key.startsWith(BOOTSTRAP_RETRY_PREFIX)) retryRow = row.value;
    else if (row.key.startsWith(BOOTSTRAP_ATTEMPTS_HEALED_PREFIX)) legacyHealed = true;
    else if (row.key.startsWith(BOOTSTRAP_ATTEMPTS_PREFIX)) legacyAttempts = parseLegacyAttempts(row.value);
  }

  const persisted = retryRow === null ? null : parseBootstrapRetryState(retryRow);
  if (!persisted) {
    return {
      state: migrateLegacyBootstrapMarkers({
        legacyAttempts,
        legacyHealed,
        hasBoardCheckpoint,
        now: clock.now,
        random: clock.random,
      }),
      migratedFromLegacy: true,
    };
  }

  // An older bundle ran in between and counted something real: fold the excess
  // back in rather than letting a rollback launder failures away.
  const unmirroredAttempts = Math.max(0, legacyAttempts - persisted.mirroredAttempts);
  if (unmirroredAttempts === 0) return { state: persisted, migratedFromLegacy: false };
  return {
    state: {
      ...persisted,
      structuralFailures: persisted.structuralFailures + unmirroredAttempts,
      hasPriorSnapshotFailure: true,
      mirroredAttempts: legacyAttempts,
    },
    migratedFromLegacy: false,
  };
}

/**
 * Persist a retry state AND its legacy mirror. The mirror is what keeps an OTA
 * rollback honest, so it lives in exactly one function — there is no second
 * place that can forget it.
 *
 * The rows go down in ONE transaction when the handle offers one, because the
 * read path infers "an older bundle counted failures we never saw" from the
 * legacy counter sitting above `mirroredAttempts`. A torn write would forge that
 * evidence: a user retry lowers the counter from 2 to 0, and if only the JSON
 * row committed, the next read would fold the stale 2 back into
 * `structuralFailures` and settle the scope again — the confirmed retry
 * silently lost. A plain `SqlExecutor` (no transaction method) still works; it
 * just falls back to the two autocommit statements.
 */
export async function writeBootstrapRetryState(
  db: SqlExecutor | OfflineDatabase,
  scopeKey: string,
  state: BootstrapRetryState,
): Promise<BootstrapRetryState> {
  // A lock-terminal scope (issue #4310) mirrors as a spent structural budget,
  // which is the honest rollback posture: an older bundle has no `lockFailures`
  // field and charged the same failure structurally, so "terminal, on the paged
  // crawl" is exactly what it should read.
  const terminal = isTerminal(state);
  const legacyAttempts = terminal
    ? MAX_BOOTSTRAP_ATTEMPTS
    : Math.min(state.structuralFailures, MAX_BOOTSTRAP_ATTEMPTS - 1);
  const mirrored: BootstrapRetryState = { ...state, mirroredAttempts: legacyAttempts };

  const writeRows = async (txn: SqlExecutor): Promise<void> => {
    await txn.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `${BOOTSTRAP_RETRY_PREFIX}${scopeKey}`,
      JSON.stringify(mirrored),
    ]);
    await txn.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
      String(legacyAttempts),
    ]);
    if (mirrored.legacyHealSpent) {
      await txn.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
        `${BOOTSTRAP_ATTEMPTS_HEALED_PREFIX}${scopeKey}`,
        '1',
      ]);
    }
  };

  // Never called from inside another transaction — every call site settles a
  // bootstrap decision between phases, not during the snapshot import — so the
  // exclusive lock here can't nest.
  if ('withExclusiveTransactionAsync' in db) {
    await db.withExclusiveTransactionAsync(writeRows);
  } else {
    await writeRows(db);
  }
  return mirrored;
}

/** Read a scope's legacy attempt counter (the rollback mirror, not the budget). */
export async function getBootstrapAttempts(db: SqlExecutor, scopeKey: string): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    `${BOOTSTRAP_ATTEMPTS_PREFIX}${scopeKey}`,
  ]);
  return row ? parseLegacyAttempts(row.value) : 0;
}

/** Persist that the latest bootstrap decision selected the ordinary paged crawl. */
export async function markBootstrapPagedFallback(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
    `${BOOTSTRAP_PAGED_FALLBACK_PREFIX}${scopeKey}`,
    '1',
  ]);
}

/** A new eligible snapshot attempt supersedes a prior run's paged decision. */
export async function clearBootstrapPagedFallback(db: SqlExecutor, scopeKey: string): Promise<void> {
  await db.runAsync('DELETE FROM sync_meta WHERE key = ?', [`${BOOTSTRAP_PAGED_FALLBACK_PREFIX}${scopeKey}`]);
}

/**
 * Restore both budgets for a scope the user explicitly asked to retry, drop the
 * paged-fallback caption so My Boards stops promising the slow path, and arm the
 * one-shot `userRequested` flag the bootstrap phase reads to override the
 * metered-link defer. Returns the state that was written.
 */
export async function restoreBootstrapRetryBudget(
  db: SqlExecutor | OfflineDatabase,
  scopeKey: string,
): Promise<BootstrapRetryState> {
  const { state } = await readBootstrapRetryState(db, scopeKey, { now: 0, random: () => 0 }, false);
  const written = await writeBootstrapRetryState(db, scopeKey, clearRetryStateForUserRequest(state));
  await clearBootstrapPagedFallback(db, scopeKey);
  return written;
}
