/**
 * Backend test files that share cluster-wide state and so must never run at
 * the same time as each other: they create and drop Postgres roles, run the
 * migrator's worker-grant block (REVOKE/GRANT on every public table), and wipe
 * the pg-boss queues and the background job ledger in `beforeEach`. Two of them
 * running concurrently fail with "tuple concurrently updated" or find the other
 * file's jobs in their queue. They run in the `backend-serial` project
 * (vite.serial.config.ts), one file at a time, and the `backend` project
 * excludes them. Add a file here when it does any of the above.
 */
export const SERIAL_TEST_FILES = [
  'src/workers/__tests__/jobs.test.ts',
  'src/workers/families/__tests__/aurora-user-sync.test.ts',
  'src/workers/families/__tests__/kilter-user-sync.test.ts',
  'src/workers/families/__tests__/provider-routine-cycle.test.ts',
  'src/services/__tests__/job-queue-roles.test.ts',
  'src/services/__tests__/job-queue-roles-routine.test.ts',
  'src/services/__tests__/job-queue-roles-snapshots.test.ts',
  'src/__tests__/aurora-credentials-enqueue.test.ts',
  'src/__tests__/request-provider-sync.test.ts',
  'src/__tests__/provider-sync-control.test.ts',
  'src/__tests__/spray-detection.test.ts',
];
