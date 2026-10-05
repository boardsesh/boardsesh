import type { SQLiteDatabase } from 'expo-sqlite';
import { SchemaNewerThanAppError } from '@boardsesh/offline-sync';
import type { SchemaDowngrade } from './schema-downgrade';

/**
 * A stand-in for a connection this bundle must not use: every method refuses with
 * `SchemaNewerThanAppError`, and nothing reaches SQLite.
 *
 * WHY THIS EXISTS. `getDatabaseHandle()` staying null already keeps the non-React
 * callers off a database a newer bundle migrated. But `SQLiteProvider` hands its
 * connection to every `useSQLiteContext()` consumer regardless, and several of
 * those run without the schema-ready gate: the Sync-issues retry drains the
 * outbox, Storage removes a board and vacuums, My Boards restores a download's
 * retry budget. Against a database with missing tables those calls throw. Against
 * a NEWER one the tables exist, so the calls would succeed, and older code would
 * be sending, dead-lettering or deleting rows whose shape it does not know.
 *
 * Refusing at the connection covers every such call site, including ones added
 * later, instead of asking each to remember a second gate.
 *
 * `…Async` methods reject; everything else throws, because a synchronous caller
 * cannot await a rejection. Non-function members (`databasePath`, `options`) are
 * passed through: they describe the connection without touching the file.
 *
 * One stand-in per connection, so a consumer that lists `db` in an effect's deps
 * sees a stable identity.
 */
const refusedByConnection = new WeakMap<SQLiteDatabase, SQLiteDatabase>();

export function refuseDatabase(connection: SQLiteDatabase, downgrade: SchemaDowngrade): SQLiteDatabase {
  const existing = refusedByConnection.get(connection);
  if (existing !== undefined) return existing;

  const refused = new Proxy(connection, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return () => {
        const error = new SchemaNewerThanAppError(downgrade.storedVersion, downgrade.supportedVersion);
        if (typeof property === 'string' && property.endsWith('Async')) return Promise.reject(error);
        throw error;
      };
    },
  });
  refusedByConnection.set(connection, refused);
  return refused;
}
