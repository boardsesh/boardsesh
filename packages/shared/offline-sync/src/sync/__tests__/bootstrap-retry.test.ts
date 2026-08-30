// The failure taxonomy, budgets and cooldown ladders that replaced "2 attempts
// then paged forever" (issue #4313). Everything here is pure — the clock and the
// jitter source are injected — plus the two SQLite helpers, which run against the
// real client DDL so the legacy dual-write is exercised for real.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOOTSTRAP_RETRY_GRACE_WINDOW_MS,
  EMPTY_BOOTSTRAP_RETRY_STATE,
  MAX_BOOTSTRAP_ATTEMPTS,
  MAX_BOOTSTRAP_LOCK_FAILURES,
  MAX_FREE_BACKGROUND_PAUSES,
  MAX_STRUCTURAL_REARMS,
  MAX_TRANSPORT_DOWNLOAD_FAILURES,
  canRearmOnNewArtifact,
  classifyBootstrapFailure,
  clearRetryStateForUserRequest,
  clearTransportFailures,
  evaluateBootstrapEligibility,
  getBootstrapAttempts,
  isTerminal,
  migrateLegacyBootstrapMarkers,
  nextRetryState,
  readBootstrapRetryState,
  rearmForNewArtifact,
  recordBackgroundPause,
  restoreBootstrapRetryBudget,
  shouldSkipPagedPull,
  spendUserRequest,
  writeBootstrapRetryState,
  type BootstrapFailureKind,
  type BootstrapRetryState,
} from '../bootstrap-retry';
import { SnapshotArtifactTruncatedError, SnapshotBackgroundTransferInterruptedError } from '../snapshot-bootstrap';
import { runMigrations } from '../../db/migrations';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

/** No jitter: every cooldown lands on its base rung, so assertions are exact. */
const noJitter = () => 0;

function state(patch: Partial<BootstrapRetryState> = {}): BootstrapRetryState {
  return { ...EMPTY_BOOTSTRAP_RETRY_STATE, ...patch };
}

function burn(
  from: BootstrapRetryState,
  failureKind: BootstrapFailureKind,
  options: { builtAt?: string | null; now?: number; random?: () => number } = {},
): BootstrapRetryState {
  return nextRetryState({
    state: from,
    failureKind,
    builtAt: options.builtAt ?? null,
    now: options.now ?? NOW,
    random: options.random ?? noJitter,
  });
}

describe('classifyBootstrapFailure', () => {
  it('routes a dropped connection at the download stage to the transport budget', () => {
    // The exact shape iOS raises for the case in issue #4313's Sentry sample.
    const cause = new Error('snapshot download: File.downloadFileAsync failed', {
      cause: new Error('UnableToDownloadException: The request timed out.'),
    });
    expect(classifyBootstrapFailure({ cause, stage: 'download' })).toBe('transport');
    expect(classifyBootstrapFailure({ cause: new TypeError('Network request failed'), stage: 'manifest' })).toBe(
      'transport',
    );
  });

  it('attributes an import failure to the ARTIFACT — the bytes are on disk', () => {
    expect(classifyBootstrapFailure({ cause: new Error('quick_check failed'), stage: 'import' })).toBe(
      'structural-artifact',
    );
  });

  it('routes a SHORT body at the download stage to the transport budget', () => {
    // A cut-short response is a transport symptom. `structural-device` would
    // durably settle the scope onto the paged crawl after two occurrences with
    // no `builtAt` re-arm — far too harsh for what is at least as likely a
    // one-off network fluke as a systematic device fault (issue #4394).
    const cause = new SnapshotArtifactTruncatedError(
      'snapshot download: short body for kilter:1 (expected 269316096 bytes, got 4096)',
    );
    expect(classifyBootstrapFailure({ cause, stage: 'download' })).toBe('transport');
    // At the IMPORT stage every failure is artifact-attributable, unchanged.
    expect(classifyBootstrapFailure({ cause, stage: 'import' })).toBe('structural-artifact');
  });

  it('routes a background-transfer marker to transport by its stable error name', () => {
    const localMarker = new SnapshotBackgroundTransferInterruptedError('cannot decode raw data');
    const crossBundleMarker = new Error('cannot decode raw data');
    crossBundleMarker.name = 'SnapshotBackgroundTransferInterruptedError';

    expect(classifyBootstrapFailure({ cause: localMarker, stage: 'download' })).toBe('transport');
    expect(classifyBootstrapFailure({ cause: crossBundleMarker, stage: 'download' })).toBe('transport');
  });

  it('attributes an unclassifiable download failure to the DEVICE, not the artifact', () => {
    // Conservative on purpose: a plain Error from an adapter's downloader could
    // be disk-full or a cache-dir fault, and a nightly rebuild must not re-arm
    // the budget for either of those.
    expect(classifyBootstrapFailure({ cause: new Error('insufficient disk space'), stage: 'download' })).toBe(
      'structural-device',
    );
  });
});

describe('cooldown ladders', () => {
  it('walks the transport ladder 2 min → 15 min → 2 h', () => {
    let current = state();
    current = burn(current, 'transport');
    expect(current.retryAfter).toBe(NOW + 2 * MINUTE);
    current = burn(current, 'transport');
    expect(current.retryAfter).toBe(NOW + 15 * MINUTE);
    current = burn(current, 'transport');
    expect(current.retryAfter).toBe(NOW + 2 * HOUR);
  });

  it('walks the structural ladder 6 h → 24 h', () => {
    let current = state();
    current = burn(current, 'structural-device');
    expect(current.retryAfter).toBe(NOW + 6 * HOUR);
    current = burn(current, 'structural-device');
    expect(current.retryAfter).toBe(NOW + 24 * HOUR);
  });

  it('jitters within [1x, 1.5x) so a fleet that failed together does not retry together', () => {
    const atFloor = burn(state(), 'transport', { random: () => 0 });
    const nearCeiling = burn(state(), 'transport', { random: () => 0.999999 });
    expect(atFloor.retryAfter! - NOW).toBe(2 * MINUTE);
    expect(nearCeiling.retryAfter! - NOW).toBeGreaterThan(2 * MINUTE);
    expect(nearCeiling.retryAfter! - NOW).toBeLessThanOrEqual(3 * MINUTE);
  });
});

describe('budgets', () => {
  it('spends the transport budget without ever touching the structural one', () => {
    let current = state();
    for (let failure = 0; failure < MAX_TRANSPORT_DOWNLOAD_FAILURES; failure += 1) {
      expect(isTerminal(current)).toBe(false);
      current = burn(current, 'transport');
    }
    expect(current.structuralFailures).toBe(0);
    expect(current.transportFailures).toBe(MAX_TRANSPORT_DOWNLOAD_FAILURES);
    expect(isTerminal(current)).toBe(true);
  });

  it('resets the transport counter and its cooldown on a successful download', () => {
    const afterTwo = burn(burn(state(), 'transport'), 'transport');
    const recovered = clearTransportFailures(afterTwo);
    expect(recovered.transportFailures).toBe(0);
    expect(recovered.retryAfter).toBeNull();
    // …and the ladder starts again at its first rung, not where it left off.
    expect(burn(recovered, 'transport').retryAfter).toBe(NOW + 2 * MINUTE);
  });

  it('settles a scope after MAX_BOOTSTRAP_ATTEMPTS structural failures', () => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1)
      current = burn(current, 'structural-artifact');
    expect(isTerminal(current)).toBe(true);
  });

  // Issue #4310. Batching turned one lock acquisition into ~143, so a lost race
  // needed a budget of its own — neither of the other two can hold it.
  it('spends the lock budget without touching the structural or transport ones', () => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_LOCK_FAILURES; failure += 1) {
      expect(isTerminal(current)).toBe(false);
      current = burn(current, 'database-locked');
    }
    expect(current.lockFailures).toBe(MAX_BOOTSTRAP_LOCK_FAILURES);
    expect(current.transportFailures).toBe(0);
    expect(current.structuralFailures).toBe(0);
    expect(current.lastFailureKind).toBe('database-locked');
    expect(isTerminal(current)).toBe(true);
  });

  it('does NOT let a successful download clear the lock budget', () => {
    // The loop this rules out: a RETAINED artifact is handed back off disk with
    // zero bytes moved, and the caller still runs clearTransportFailures. On the
    // transport budget the counter would be reset every cycle, never reach its
    // cap, and the scope would never go terminal — while shouldSkipPagedPull kept
    // skipping the crawl on the 2-minute cooldown. No board, by either path.
    let current = state();
    for (let cycle = 0; cycle < MAX_BOOTSTRAP_LOCK_FAILURES; cycle += 1) {
      // Exactly the caller's order: the reuse "succeeds", then the import fails.
      current = clearTransportFailures(current);
      current = burn(current, 'database-locked');
    }
    expect(current.lockFailures).toBe(MAX_BOOTSTRAP_LOCK_FAILURES);
    expect(isTerminal(current)).toBe(true);
    // Terminal is what lets the fresh scope fall through to its paged crawl.
    expect(shouldSkipPagedPull({ retryState: current, hasBoardCheckpoint: false, now: NOW })).toBe(false);
  });

  it('walks the lock ladder on the transport rungs — contention clears in minutes', () => {
    let current = burn(state(), 'database-locked');
    expect(current.retryAfter).toBe(NOW + 2 * MINUTE);
    // Under the 30-minute grace window, so a fresh scope waits rather than
    // spending 400 round trips on a crawl the artifact is about to make moot.
    expect(shouldSkipPagedPull({ retryState: current, hasBoardCheckpoint: false, now: NOW })).toBe(true);
    current = burn(current, 'database-locked');
    expect(current.retryAfter).toBe(NOW + 15 * MINUTE);
  });

  it('never re-arms a lock-terminal scope on a newly built artifact', () => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_LOCK_FAILURES; failure += 1)
      current = burn(current, 'database-locked', { builtAt: '2026-08-01T00:00:00.000Z' });
    // Tonight's export cannot win a write-lock race the last one lost. The
    // consented escape is the retry action, which restores every budget.
    expect(canRearmOnNewArtifact(current)).toBe(false);
    expect(clearRetryStateForUserRequest(current).lockFailures).toBe(0);
  });
});

describe('recordBackgroundPause', () => {
  const pause = (from: BootstrapRetryState) =>
    recordBackgroundPause({ state: from, builtAt: null, now: NOW, random: noJitter });

  it('costs nothing for the first MAX_FREE_BACKGROUND_PAUSES — a pocketed phone is not a fault', () => {
    let current = state();
    for (let count = 1; count <= MAX_FREE_BACKGROUND_PAUSES; count += 1) {
      const result = pause(current);
      expect(result.charged).toBe(false);
      expect(result.state.backgroundPauses).toBe(count);
      expect(result.state.transportFailures).toBe(0);
      expect(result.state.retryAfter).toBeNull();
      expect(result.state.hasPriorSnapshotFailure).toBe(false);
      current = result.state;
    }
  });

  it('charges the next one to the transport budget on its ladder', () => {
    let current = state();
    for (let count = 0; count < MAX_FREE_BACKGROUND_PAUSES; count += 1) current = pause(current).state;

    const charged = pause(current);

    expect(charged.charged).toBe(true);
    expect(charged.state.transportFailures).toBe(1);
    expect(charged.state.lastFailureKind).toBe('transport');
    expect(charged.state.retryAfter).toBe(NOW + 2 * MINUTE);
    // Reset as it charges, so the pattern terminates at 3 free + 3 transport
    // rather than charging every pause from here on.
    expect(charged.state.backgroundPauses).toBe(0);
  });

  it('is cleared by a completed download — landed bytes prove the device can finish', () => {
    const paused = pause(pause(state()).state).state;
    expect(clearTransportFailures(paused).backgroundPauses).toBe(0);
  });

  it('is cleared by the user tapping "Try the fast download again"', () => {
    const paused = pause(pause(state()).state).state;
    expect(clearRetryStateForUserRequest(paused).backgroundPauses).toBe(0);
  });
});

describe('re-arming on a newly built artifact', () => {
  const spendStructural = (kind: BootstrapFailureKind, builtAt: string): BootstrapRetryState => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1) current = burn(current, kind, { builtAt });
    return current;
  };

  it('re-arms an ARTIFACT-attributable scope once, and only once', () => {
    let current = spendStructural('structural-artifact', 'build-1');
    expect(canRearmOnNewArtifact(current)).toBe(true);

    current = rearmForNewArtifact(current, 'build-2');
    expect(isTerminal(current)).toBe(false);
    expect(current.retryAfter).toBeNull();
    expect(current.structuralRearms).toBe(MAX_STRUCTURAL_REARMS);

    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1) {
      current = burn(current, 'structural-artifact', { builtAt: 'build-2' });
    }
    expect(isTerminal(current)).toBe(true);
    // The export is nightly, so without this cap every launch would offer a
    // "new" builtAt and the scope would download 2 x 103 MB per day forever.
    expect(canRearmOnNewArtifact(current)).toBe(false);
  });

  it('never re-arms a DEVICE-attributable scope, however many nightly rebuilds land', () => {
    const current = spendStructural('structural-device', 'build-1');
    expect(isTerminal(current)).toBe(true);
    expect(canRearmOnNewArtifact(current)).toBe(false);
  });

  it('never re-arms a scope whose transport budget is spent', () => {
    let current = spendStructural('structural-artifact', 'build-1');
    current = { ...current, transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES };
    expect(canRearmOnNewArtifact(current)).toBe(false);
  });
});

describe('evaluateBootstrapEligibility', () => {
  const evaluate = (patch: Partial<Parameters<typeof evaluateBootstrapEligibility>[0]> = {}) =>
    evaluateBootstrapEligibility({
      retryState: state(),
      hasBoardCheckpoint: false,
      isScopeComplete: false,
      isBootstrapDone: false,
      now: NOW,
      ...patch,
    });

  it('admits a fresh scope', () => {
    expect(evaluate()).toEqual({ eligible: true, kind: 'fresh' });
  });

  it('admits a mid-crawl scope that carries snapshot-path failures', () => {
    expect(
      evaluate({
        hasBoardCheckpoint: true,
        retryState: state({ transportFailures: 1, hasPriorSnapshotFailure: true }),
      }),
    ).toEqual({ eligible: true, kind: 'heal-over-partial' });
  });

  it('admits a mid-crawl scope even when startup paged before any snapshot failure was recorded', () => {
    expect(evaluate({ hasBoardCheckpoint: true })).toEqual({ eligible: true, kind: 'heal-over-partial' });
  });

  it('never heals a scope that already serves the whole catalog offline', () => {
    // It holds every row locally; 103 MB buys it nothing until its next teardown.
    expect(
      evaluate({
        isScopeComplete: true,
        hasBoardCheckpoint: true,
        retryState: state({ structuralFailures: 1, hasPriorSnapshotFailure: true }),
      }),
    ).toMatchObject({ eligible: false, reason: 'scope-complete' });
  });

  it('never re-runs for a scope that already imported an artifact', () => {
    expect(evaluate({ isBootstrapDone: true })).toMatchObject({ eligible: false, reason: 'bootstrap-done' });
  });

  it('holds a scope until its scheduled retry, then admits it', () => {
    const cooling = state({ transportFailures: 1, hasPriorSnapshotFailure: true, retryAfter: NOW + 1 });
    expect(evaluate({ retryState: cooling })).toMatchObject({ eligible: false, reason: 'cooling-down' });
    expect(evaluate({ retryState: { ...cooling, retryAfter: NOW } })).toEqual({ eligible: true, kind: 'fresh' });
  });

  it('reports a terminal scope and whether tonight’s export could revive it', () => {
    expect(evaluate({ retryState: state({ transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES }) })).toMatchObject({
      eligible: false,
      reason: 'terminal',
      canRearm: false,
    });
    expect(
      evaluate({
        retryState: state({ structuralFailures: MAX_BOOTSTRAP_ATTEMPTS, lastFailureKind: 'structural-artifact' }),
      }),
    ).toMatchObject({ eligible: false, reason: 'terminal', canRearm: true });
  });
});

describe('shouldSkipPagedPull', () => {
  const skip = (patch: Partial<Parameters<typeof shouldSkipPagedPull>[0]> = {}) =>
    shouldSkipPagedPull({ retryState: state(), hasBoardCheckpoint: false, now: NOW, ...patch });

  it('waits for an imminent retry on a fresh scope', () => {
    expect(skip({ retryState: state({ retryAfter: NOW + 2 * MINUTE }) })).toBe(true);
    expect(skip({ retryState: state({ retryAfter: NOW + BOOTSTRAP_RETRY_GRACE_WINDOW_MS }) })).toBe(true);
  });

  it('runs the crawl rather than leave a board empty for a 2-hour cooldown', () => {
    expect(skip({ retryState: state({ retryAfter: NOW + 2 * HOUR }) })).toBe(false);
  });

  it('never stalls a scope that is already making crawl progress', () => {
    expect(skip({ hasBoardCheckpoint: true, retryState: state({ retryAfter: NOW + MINUTE }) })).toBe(false);
  });

  it('never stalls a settled scope — the crawl is the only path it has left', () => {
    expect(skip({ retryState: state({ transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES }) })).toBe(false);
  });
});

describe('legacy marker migration', () => {
  it('grants a stranded scope one clean pass instead of inheriting the conflated counter', () => {
    // The legacy counter mixed transport failures in with real defects — that IS
    // the bug — so carrying its value forward would strand the same users again.
    const migrated = migrateLegacyBootstrapMarkers({
      legacyAttempts: MAX_BOOTSTRAP_ATTEMPTS,
      legacyHealed: false,
      hasBoardCheckpoint: false,
      now: NOW,
      random: noJitter,
    });
    expect(isTerminal(migrated)).toBe(false);
    expect(migrated.structuralFailures).toBe(0);
    expect(migrated.hasPriorSnapshotFailure).toBe(true);
    expect(migrated.retryAfter).toBeNull();
    // The old bundle's one-shot heal is pre-spent, so a rollback can't re-grant it.
    expect(migrated.legacyHealSpent).toBe(true);
    expect(migrated.mirroredAttempts).toBe(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it('spreads the post-OTA wave for scopes that already hold rows', () => {
    const early = migrateLegacyBootstrapMarkers({
      legacyAttempts: 2,
      legacyHealed: false,
      hasBoardCheckpoint: true,
      now: NOW,
      random: () => 0,
    });
    const late = migrateLegacyBootstrapMarkers({
      legacyAttempts: 2,
      legacyHealed: false,
      hasBoardCheckpoint: true,
      now: NOW,
      random: () => 0.9,
    });
    expect(early.retryAfter).toBe(NOW);
    expect(late.retryAfter).toBeGreaterThan(NOW + HOUR);
    expect(late.retryAfter).toBeLessThan(NOW + 2 * HOUR);
  });

  it('spends the re-arm budget for a scope that already used the old one-shot heal', () => {
    const migrated = migrateLegacyBootstrapMarkers({
      legacyAttempts: 2,
      legacyHealed: true,
      hasBoardCheckpoint: false,
      now: NOW,
      random: noJitter,
    });
    expect(migrated.structuralRearms).toBe(MAX_STRUCTURAL_REARMS);
  });

  it('leaves a never-failed scope completely untouched', () => {
    expect(
      migrateLegacyBootstrapMarkers({
        legacyAttempts: 0,
        legacyHealed: false,
        hasBoardCheckpoint: true,
        now: NOW,
        random: noJitter,
      }),
    ).toEqual(EMPTY_BOOTSTRAP_RETRY_STATE);
  });
});

describe('clearRetryStateForUserRequest', () => {
  it('restores both budgets and the re-arm, keeping the rollback mirrors honest', () => {
    const settled = state({
      transportFailures: MAX_TRANSPORT_DOWNLOAD_FAILURES,
      structuralFailures: MAX_BOOTSTRAP_ATTEMPTS,
      structuralRearms: MAX_STRUCTURAL_REARMS,
      retryAfter: NOW + 24 * HOUR,
      mirroredAttempts: MAX_BOOTSTRAP_ATTEMPTS,
      hasPriorSnapshotFailure: true,
    });
    const cleared = clearRetryStateForUserRequest(settled);
    expect(isTerminal(cleared)).toBe(false);
    expect(cleared.retryAfter).toBeNull();
    expect(cleared.structuralRearms).toBe(0);
    expect(cleared.legacyHealSpent).toBe(true);
  });

  it('makes the scope actually eligible again — a settled board has always crawled', () => {
    // Keep this pinned for rollback compatibility: older bundles still use the
    // retained failure-history bit to admit a checkpointed retry.
    const settled = state({
      structuralFailures: MAX_BOOTSTRAP_ATTEMPTS,
      retryAfter: NOW + 24 * HOUR,
      hasPriorSnapshotFailure: true,
      lastFailureKind: 'structural-device',
    });
    expect(
      evaluateBootstrapEligibility({
        retryState: clearRetryStateForUserRequest(settled),
        hasBoardCheckpoint: true,
        isScopeComplete: false,
        isBootstrapDone: false,
        now: NOW,
      }),
    ).toEqual({ eligible: true, kind: 'heal-over-partial' });
  });

  it('arms a one-shot user-request flag that survives one download and no more', () => {
    // The flag is what lets the tap through the metered defer. Spending it as the
    // download STARTS keeps a failure from leaving a standing licence to pull
    // ~100 MB over cellular on every later cooldown.
    const armed = clearRetryStateForUserRequest(state({ hasPriorSnapshotFailure: true }));
    expect(armed.userRequested).toBe(true);
    const spent = spendUserRequest(armed);
    expect(spent.userRequested).toBe(false);
    expect(spendUserRequest(spent)).toBe(spent);
  });
});

// ---------------------------------------------------------------------------
// Persistence + the legacy dual-write, against the real DDL
// ---------------------------------------------------------------------------

describe('bootstrap-retry persistence', () => {
  let workDir: string;
  let db: TestSqliteDb;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bootstrap-retry-'));
    db = createTestDatabase(join(workDir, 'client.db'));
    await runMigrations(db);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const readMeta = async (key: string): Promise<string | null> => {
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [key]);
    return row ? row.value : null;
  };

  it('mirrors the legacy rows on every write and never deletes them', async () => {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts:kilter:1:5',
      '2',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts-healed:kilter:1:5',
      '1',
    ]);

    const { state: migrated, migratedFromLegacy } = await readBootstrapRetryState(
      db,
      'kilter:1:5',
      { now: NOW, random: noJitter },
      false,
    );
    expect(migratedFromLegacy).toBe(true);
    const written = await writeBootstrapRetryState(db, 'kilter:1:5', burn(migrated, 'structural-artifact'));

    expect(await readMeta('bootstrap-retry:kilter:1:5')).not.toBeNull();
    // One structural failure spent, not yet terminal, so the legacy view is 1.
    expect(await readMeta('bootstrap-attempts:kilter:1:5')).toBe('1');
    // A rolled-back bundle must not re-grant the one-shot heal it already spent.
    expect(await readMeta('bootstrap-attempts-healed:kilter:1:5')).toBe('1');
    expect(written.mirroredAttempts).toBe(1);
  });

  it('mirrors a terminal scope as the legacy cap so an old bundle also gives up', async () => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1) current = burn(current, 'structural-device');
    await writeBootstrapRetryState(db, 'kilter:1:5', current);
    expect(await readMeta('bootstrap-attempts:kilter:1:5')).toBe(String(MAX_BOOTSTRAP_ATTEMPTS));
  });

  it('rolls the JSON row back when the legacy mirror fails, so a torn write cannot forge failures', async () => {
    // The read path infers "a rolled-back bundle counted something real" from the
    // legacy counter sitting ABOVE mirroredAttempts. Committing the JSON row on
    // its own would forge that evidence: a user retry drops the counter from 2 to
    // 0, and the next read would fold the stale 2 straight back into
    // structuralFailures and settle the scope again — the confirmed retry lost.
    let settled = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1) settled = burn(settled, 'structural-device');
    await writeBootstrapRetryState(db, 'kilter:1:5', settled);
    const jsonBefore = await readMeta('bootstrap-retry:kilter:1:5');

    // Fails the SECOND statement inside the transaction (the legacy mirror),
    // which is exactly the window a kill or a disk error can land in.
    const failingLegacyWrite = {
      execAsync: (source: string) => db.execAsync(source),
      runAsync: (source: string, params: string[]) => db.runAsync(source, params),
      getFirstAsync: (source: string, params: string[]) => db.getFirstAsync(source, params),
      getAllAsync: (source: string, params: string[]) => db.getAllAsync(source, params),
      withExclusiveTransactionAsync: (task: (txn: TestSqliteDb) => Promise<void>) =>
        db.withExclusiveTransactionAsync(async (txn) => {
          let writes = 0;
          await task({
            execAsync: (source: string) => txn.execAsync(source),
            getFirstAsync: (source: string, params: string[]) => txn.getFirstAsync(source, params),
            getAllAsync: (source: string, params: string[]) => txn.getAllAsync(source, params),
            runAsync: async (source: string, params: string[]) => {
              writes += 1;
              if (writes === 2) throw new Error('disk I/O error');
              return txn.runAsync(source, params);
            },
          } as unknown as TestSqliteDb);
        }),
    } as unknown as TestSqliteDb;

    await expect(
      writeBootstrapRetryState(failingLegacyWrite, 'kilter:1:5', clearRetryStateForUserRequest(settled)),
    ).rejects.toThrow('disk I/O error');

    // Neither row moved: the scope is still settled, not half-retried.
    expect(await readMeta('bootstrap-retry:kilter:1:5')).toBe(jsonBefore);
    expect(await readMeta('bootstrap-attempts:kilter:1:5')).toBe(String(MAX_BOOTSTRAP_ATTEMPTS));
    const { state: reread } = await readBootstrapRetryState(db, 'kilter:1:5', { now: NOW, random: noJitter }, true);
    expect(reread.structuralFailures).toBe(MAX_BOOTSTRAP_ATTEMPTS);
  });

  it('folds back failures an older bundle counted while it was rolled back', async () => {
    await writeBootstrapRetryState(db, 'kilter:1:5', state({ hasPriorSnapshotFailure: true }));
    // A rolled-back bundle runs and bumps only the legacy counter it knows about.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-attempts:kilter:1:5',
      '2',
    ]);

    const { state: reconciled } = await readBootstrapRetryState(
      db,
      'kilter:1:5',
      { now: NOW, random: noJitter },
      false,
    );
    expect(reconciled.structuralFailures).toBe(2);
    expect(isTerminal(reconciled)).toBe(true);
  });

  it('round-trips a persisted state without laundering anything', async () => {
    const written = await writeBootstrapRetryState(
      db,
      'kilter:1:5',
      state({
        transportFailures: 2,
        backgroundPauses: 2,
        structuralFailures: 1,
        structuralRearms: 1,
        lastFailureKind: 'structural-artifact',
        failedBuiltAt: 'build-7',
        retryAfter: NOW + HOUR,
        hasPriorSnapshotFailure: true,
      }),
    );
    const { state: reread, migratedFromLegacy } = await readBootstrapRetryState(
      db,
      'kilter:1:5',
      { now: NOW, random: noJitter },
      false,
    );
    expect(migratedFromLegacy).toBe(false);
    expect(reread).toEqual(written);
  });

  it('round-trips a lock-terminal state, and mirrors it as terminal for a rolled-back bundle', async () => {
    // A pre-#4310 bundle has no `lockFailures` field, so the legacy mirror is all
    // it can read. Writing MAX_BOOTSTRAP_ATTEMPTS there keeps the honest verdict:
    // terminal, on the paged crawl — which is what the older bundle would have
    // concluded from the same failure charged structurally.
    let locked = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_LOCK_FAILURES; failure += 1) locked = burn(locked, 'database-locked');
    const written = await writeBootstrapRetryState(db, 'kilter:1:5', locked);
    expect(await getBootstrapAttempts(db, 'kilter:1:5')).toBe(MAX_BOOTSTRAP_ATTEMPTS);

    const { state: reread } = await readBootstrapRetryState(db, 'kilter:1:5', { now: NOW, random: noJitter }, false);
    expect(reread).toEqual(written);
    expect(reread.lockFailures).toBe(MAX_BOOTSTRAP_LOCK_FAILURES);
    expect(reread.lastFailureKind).toBe('database-locked');
    // The legacy fold must not double-charge on the way back in.
    expect(reread.structuralFailures).toBe(0);
  });

  it('defaults a missing lockFailures to 0 — the pre-#4310 row shape is not a corruption', async () => {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-retry:kilter:1:5',
      JSON.stringify({ transportFailures: 1, structuralFailures: 0, hasPriorSnapshotFailure: true }),
    ]);
    const { state: recovered } = await readBootstrapRetryState(db, 'kilter:1:5', { now: NOW, random: noJitter }, false);
    expect(recovered.lockFailures).toBe(0);
    expect(isTerminal(recovered)).toBe(false);
  });

  it('defaults a missing backgroundPauses to 0, so a rolled-back bundle only loses the bound', async () => {
    // The shape an older bundle writes: no `backgroundPauses` key at all. Zero
    // is the pre-#4390 behaviour (unbounded free pauses), not a corruption.
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-retry:kilter:1:5',
      JSON.stringify({ transportFailures: 1, structuralFailures: 0, hasPriorSnapshotFailure: true }),
    ]);
    const { state: recovered, migratedFromLegacy } = await readBootstrapRetryState(
      db,
      'kilter:1:5',
      { now: NOW, random: noJitter },
      false,
    );
    expect(migratedFromLegacy).toBe(false);
    expect(recovered.backgroundPauses).toBe(0);
    expect(recovered.transportFailures).toBe(1);
  });

  it('treats a corrupt retry row as an un-migrated scope rather than crashing the cycle', async () => {
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-retry:kilter:1:5',
      'not json',
    ]);
    const { state: recovered, migratedFromLegacy } = await readBootstrapRetryState(
      db,
      'kilter:1:5',
      { now: NOW, random: noJitter },
      false,
    );
    expect(migratedFromLegacy).toBe(true);
    expect(recovered).toEqual(EMPTY_BOOTSTRAP_RETRY_STATE);
  });

  it('restoreBootstrapRetryBudget revives a settled scope and drops its slow-path caption', async () => {
    let current = state();
    for (let failure = 0; failure < MAX_BOOTSTRAP_ATTEMPTS; failure += 1) current = burn(current, 'structural-device');
    await writeBootstrapRetryState(db, 'kilter:1:5', current);
    await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
      'bootstrap-paged-fallback:kilter:1:5',
      '1',
    ]);

    const restored = await restoreBootstrapRetryBudget(db, 'kilter:1:5');

    expect(isTerminal(restored)).toBe(false);
    expect(await readMeta('bootstrap-paged-fallback:kilter:1:5')).toBeNull();
    expect(await readMeta('bootstrap-attempts:kilter:1:5')).toBe('0');
    const { state: reread } = await readBootstrapRetryState(db, 'kilter:1:5', { now: NOW, random: noJitter }, true);
    expect(isTerminal(reread)).toBe(false);
    // The consent survives the round trip: without it the next cycle defers the
    // heal for 6 h on cellular and the tap does nothing at all.
    expect(reread.userRequested).toBe(true);
    // …and the engine will actually run for it on the next cycle, which is the
    // only reason the row action exists.
    expect(
      evaluateBootstrapEligibility({
        retryState: reread,
        hasBoardCheckpoint: true,
        isScopeComplete: false,
        isBootstrapDone: false,
        now: NOW,
      }).eligible,
    ).toBe(true);
  });
});
