import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchemaDowngradeForTests, setSchemaDowngrade } from '../../db/schema-downgrade';
import {
  SCHEMA_DOWNGRADE_RECOVERY_SOURCE,
  recoverFromSchemaDowngrade,
  resetSchemaDowngradeRecoveryForTests,
  watchForSchemaDowngrade,
  type SchemaDowngradeRecoveryDeps,
} from '../schema-downgrade-recovery';

function createDeps(overrides: Partial<SchemaDowngradeRecoveryDeps> = {}) {
  return {
    updatesEnabled: true,
    checkForUpdate: vi.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: false })),
    fetchUpdate: vi.fn(async () => undefined),
    track: vi.fn(),
    reportFailure: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  resetSchemaDowngradeRecoveryForTests();
  resetSchemaDowngradeForTests();
});

describe('recoverFromSchemaDowngrade', () => {
  it('downloads a newer bundle for the next cold start and says so', async () => {
    const deps = createDeps({
      checkForUpdate: vi.fn(async () => ({ isAvailable: true, isRollBackToEmbedded: false })),
    });

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBe('update-fetched');

    expect(deps.fetchUpdate).toHaveBeenCalledTimes(1);
    expect(deps.track).toHaveBeenCalledTimes(1);
    expect(deps.track).toHaveBeenCalledWith('OTA Recovery Attempted', {
      result: 'update-fetched',
      source: SCHEMA_DOWNGRADE_RECOVERY_SOURCE,
    });
  });

  it('has no way to restart the app: nothing says the fetched bundle knows the schema', () => {
    expect(Object.keys(createDeps())).not.toContain('reload');
  });

  it('fetches nothing when the server has nothing newer, and says so once', async () => {
    const deps = createDeps();

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBe('no-fix-available');

    expect(deps.fetchUpdate).not.toHaveBeenCalled();
    expect(deps.track).toHaveBeenCalledTimes(1);
    expect(deps.track).toHaveBeenCalledWith('OTA Recovery Attempted', {
      result: 'no-fix-available',
      source: SCHEMA_DOWNGRADE_RECOVERY_SOURCE,
    });
  });

  it('counts a rollback to the embedded bundle, which is older still, as nothing available', async () => {
    const deps = createDeps({
      checkForUpdate: vi.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: true })),
    });

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBe('no-fix-available');

    expect(deps.track).toHaveBeenCalledTimes(1);
  });

  it('reports a failed check and leaves the app running', async () => {
    const failure = new Error('offline');
    const deps = createDeps({
      checkForUpdate: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBe('failed');

    expect(deps.reportFailure).toHaveBeenCalledWith(failure);
    expect(deps.track).toHaveBeenCalledWith('OTA Recovery Attempted', {
      result: 'failed',
      source: SCHEMA_DOWNGRADE_RECOVERY_SOURCE,
    });
  });

  it('gives up on a check that hangs', async () => {
    const deps = createDeps({
      checkForUpdate: vi.fn(() => new Promise<never>(() => {})),
      timeoutMs: 5,
    });

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBe('failed');
  });

  it('runs once per process, however many remounts find the same file', async () => {
    const deps = createDeps();

    await recoverFromSchemaDowngrade(deps);
    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBeNull();

    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(deps.track).toHaveBeenCalledTimes(1);
  });

  it('does nothing where updates are disabled (dev, or a build without expo-updates)', async () => {
    const deps = createDeps({ updatesEnabled: false });

    await expect(recoverFromSchemaDowngrade(deps)).resolves.toBeNull();

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    expect(deps.track).not.toHaveBeenCalled();
  });
});

describe('watchForSchemaDowngrade', () => {
  const DOWNGRADE = { storedVersion: 11, supportedVersion: 10 };

  it('stays idle while the database is one this bundle can open', () => {
    const deps = createDeps();

    const unsubscribe = watchForSchemaDowngrade(deps);

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('starts the check when the init chain finds the downgrade', async () => {
    const deps = createDeps();
    const unsubscribe = watchForSchemaDowngrade(deps);

    setSchemaDowngrade(DOWNGRADE);

    await vi.waitFor(() => expect(deps.track).toHaveBeenCalledTimes(1));
    expect(deps.checkForUpdate).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('starts the check for a downgrade found before it was registered', async () => {
    const deps = createDeps();
    setSchemaDowngrade(DOWNGRADE);

    const unsubscribe = watchForSchemaDowngrade(deps);

    await vi.waitFor(() => expect(deps.checkForUpdate).toHaveBeenCalledTimes(1));
    unsubscribe();
  });

  it('stops listening once unsubscribed', () => {
    const deps = createDeps();
    watchForSchemaDowngrade(deps)();

    setSchemaDowngrade(DOWNGRADE);

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });
});
