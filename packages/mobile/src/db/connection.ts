// Database lifecycle + a module-level handle so non-React code (sync scheduler,
// mutation drainer triggered from listeners) can reach the open connection.
//
// The actual `SQLiteProvider` wiring lives elsewhere; this module only exposes
// `initializeDatabase`, which `SQLiteProvider`'s `onInit` calls, plus the handle
// accessors.

import type { SQLiteDatabase } from 'expo-sqlite';
import { ensureMutationQueueTable } from '../mutation-queue/schema';
import { runMigrations } from './migrations';

export const DATABASE_NAME = 'boardsesh.db';

let databaseHandle: SQLiteDatabase | null = null;

export function setDatabaseHandle(db: SQLiteDatabase | null): void {
  databaseHandle = db;
}

export function getDatabaseHandle(): SQLiteDatabase | null {
  return databaseHandle;
}

/**
 * Prepares an opened database for use: ensures the mutation queue table exists,
 * runs pending schema migrations, and publishes the handle for non-React callers.
 * Intended as the `SQLiteProvider` `onInit` callback. Idempotent — safe on every
 * launch and after a hot reload.
 */
export async function initializeDatabase(db: SQLiteDatabase): Promise<void> {
  await ensureMutationQueueTable(db);
  await runMigrations(db);
  setDatabaseHandle(db);
}
