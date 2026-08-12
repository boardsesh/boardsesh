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
  MAX_STRUCTURAL_REARMS,
  MAX_TRANSPORT_DOWNLOAD_FAILURES,
  canRearmOnNewArtifact,
  classifyBootstrapFailure,
  clearRetryStateForUserRequest,
  clearTransportFailures,
  evaluateBootstrapEligibility,
  isTerminal,
  migrateLegacyBootstrapMarkers,
  nextRetryState,
  readBootstrapRetryState,
  rearmForNewArtifact,
  restoreBootstrapRetryBudget,
  shouldSkipPagedPull,
  writeBootstrapRetryState,
  type BootstrapFailureKind,
  type BootstrapRetryState,
} from '../bootstrap-retry';
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

  it('refuses a mid-crawl scope with no snapshot history — it is just a crawl in progress', () => {
    expect(evaluate({ hasBoardCheckpoint: true })).toMatchObject({ eligible: false, reason: 'no-failure-evidence' });
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
    // The regression this pins: dropping `hasPriorSnapshotFailure` alongside the
    // budgets left a checkpointed scope on `no-failure-evidence`, so the whole
    // "Try the fast download again" action was a silent no-op.
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
