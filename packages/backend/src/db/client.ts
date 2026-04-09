// Re-export db client from @boardsesh/db
import { createDb, createRequestDb as createRequestDbBase } from '@boardsesh/db/client';

// Create singleton db instance for backend
export const db = createDb();

/**
 * Create a new request-scoped database instance.
 * In tests, this returns the same database instance to allow consistent mocking.
 */
export function createRequestDb() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return db;
  }
  return createRequestDbBase();
}

export type Database = typeof db;
