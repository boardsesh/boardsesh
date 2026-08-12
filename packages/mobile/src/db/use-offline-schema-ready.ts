import { useSyncExternalStore } from 'react';
import { isSchemaReady, subscribeSchemaReady } from './schema-ready';

/**
 * Whether the offline SQLite schema is in place, as a live subscription.
 *
 * Every consumer that takes its database from `useSQLiteContext()` — rather than
 * the already-null-gated `getDatabaseHandle()` — must consult this before WRITING:
 * the launch gate opens after the first init attempt regardless of outcome, so on
 * a contended launch the provider hands out a handle whose migrations never ran.
 * See ./schema-ready for the full contract.
 *
 * Read-only surfaces do NOT gate on it. They wrap their reads in a React Query
 * `queryFn`, so a missing table lands in `isError` and renders the existing empty
 * state; gating them would strand them in a permanent spinner whenever init
 * genuinely fails. They fold readiness into their `queryKey` instead, so a late
 * flip refetches.
 */
export function useOfflineSchemaReady(): boolean {
  return useSyncExternalStore(subscribeSchemaReady, isSchemaReady, () => false);
}
