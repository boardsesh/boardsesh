import 'server-only';
import { applyRequestPoolDefaults, createDb, createPool, createReadDb } from '@boardsesh/db/client';

export {
  createDb as getDb,
  createPool as getPool,
  closePool,
  createReadDb as getReadDb,
  createReadPool as getReadPool,
  closeReadPool,
  getConnectionConfig,
  rowsFromResult,
  firstRowFromResult,
  executeRows,
  executeFirstRow,
  commandCountFromResult,
  executeCommandCount,
} from '@boardsesh/db/client';

// Shared singletons. Both `sql` (postgres-js tagged template) and `dbz`
// (drizzle) are backed by the same pool from @boardsesh/db/client so a Vercel
// function instance opens one pool, not two. This module is server-only and
// every web route reaches Postgres through it, so the web server's pools end a
// session left idle inside a transaction (docs/db-connectivity.md, "Idle
// transactions end after 60 s on request pools").
applyRequestPoolDefaults();
export const sql = createPool();
export const dbz = createDb();
export const dbzRead = createReadDb();
