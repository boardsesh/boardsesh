// What the app does about a database a newer bundle migrated: ask the OTA server
// for a newer bundle, and download it if there is one.
//
// The guard itself is in db/connection.ts and it only refuses. This runs the
// check and fetch of the crash screen's "Check for a fix" button
// (lib/ota-recovery), once, as soon as the downgrade is found, so the newest JS
// is on the phone for the next cold start instead of whenever expo-updates' own
// launch check next gets to it.
//
// It does NOT reload. The crash screen reloads because the climber asked and the
// app is already broken. Here the app works, minus offline storage, and nothing
// says the fetched bundle knows the stored schema: a climber who left early
// updates would be restarted mid-session by every stable release until stable
// catches up with their database, each time for nothing.

import { getSchemaDowngrade, subscribeSchemaDowngrade } from '../db/schema-downgrade';
import { performOtaRecovery, type OtaRecoveryDeps } from './ota-recovery';

/** Tagged on the shared `OTA Recovery Attempted` event so this path is countable apart from the crash screen. */
export const SCHEMA_DOWNGRADE_RECOVERY_SOURCE = 'schema-downgrade';

/**
 * What the check came to. `update-fetched` is this path's own value: the crash
 * screen's `reloaded-*` results would claim a restart that did not happen.
 */
export type SchemaDowngradeRecoveryResult = 'update-fetched' | 'no-fix-available' | 'failed';

export type SchemaDowngradeRecoveryDeps = Pick<OtaRecoveryDeps, 'checkForUpdate' | 'fetchUpdate'> & {
  /** False in dev and on any build without expo-updates, where the calls above throw. */
  updatesEnabled: boolean;
  track: (event: string, properties: { result: SchemaDowngradeRecoveryResult; source: string }) => void;
  reportFailure: (error: unknown) => void;
  timeoutMs?: number;
};

let hasStarted = false;

/**
 * Run the update check for a schema downgrade. At most once per process: every
 * remount finds the same file, and a second check a moment later would get the
 * same answer from the server.
 *
 * A rollback-to-embedded directive counts as nothing available. The embedded
 * bundle is the oldest JS this binary has, so it cannot be the one that knows a
 * newer schema.
 */
export async function recoverFromSchemaDowngrade(
  deps: SchemaDowngradeRecoveryDeps,
): Promise<SchemaDowngradeRecoveryResult | null> {
  if (hasStarted) return null;
  hasStarted = true;
  if (!deps.updatesEnabled) return null;

  const { result, error } = await performOtaRecovery(
    {
      checkForUpdate: deps.checkForUpdate,
      fetchUpdate: deps.fetchUpdate,
      // See the top of the file: the fetched bundle launches on the next cold start.
      reload: () => Promise.resolve(),
      // Only matters for a reload, which this path never does.
      isUpdatePending: () => false,
    },
    { timeoutMs: deps.timeoutMs },
  );

  const outcome: SchemaDowngradeRecoveryResult =
    result === 'reloaded-update' ? 'update-fetched' : result === 'failed' ? 'failed' : 'no-fix-available';
  deps.track('OTA Recovery Attempted', { result: outcome, source: SCHEMA_DOWNGRADE_RECOVERY_SOURCE });
  if (outcome === 'failed') deps.reportFailure(error);
  return outcome;
}

/**
 * Start the recovery when the init chain finds a downgrade, including one it found
 * before this was called. Returns the unsubscribe function.
 *
 * Called from the root layout's module body: that module already owns the
 * expo-updates calls for the crash screen, and it is evaluated before
 * `DatabaseProvider` can mount. `connection.ts` cannot make the call itself — it
 * is loaded by node-env suites that cannot reach expo-updates.
 */
export function watchForSchemaDowngrade(deps: SchemaDowngradeRecoveryDeps): () => void {
  const startIfDowngraded = () => {
    if (getSchemaDowngrade() !== null) void recoverFromSchemaDowngrade(deps);
  };
  startIfDowngraded();
  return subscribeSchemaDowngrade(startIfDowngraded);
}

/** Test-only: allow another run. */
export function resetSchemaDowngradeRecoveryForTests(): void {
  hasStarted = false;
}
