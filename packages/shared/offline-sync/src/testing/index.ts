export { createTestDatabase, listTables, tableColumns, primaryKeyColumns, type TestSqliteDb } from './sqlite-test-db';
// Test-only state resets for the engine's module-level guards — exported here
// (not on the main entry) so app code never sees the escape hatches.
export { __resetDrainerStateForTests } from '../mutation-queue/drainer';
export { __resetSyncSchedulerStateForTests } from '../sync/sync-scheduler';
// The download funnel's one-terminal-per-teardown claim (issues #4406, #4452).
// Process-local by design, so a suite that closes more than one funnel has to
// clear it between cases or the second claim is refused.
export { __resetDownloadTerminalRegistryForTests } from '../sync/download-terminal-registry';
