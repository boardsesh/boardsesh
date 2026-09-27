import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/**
 * Any drizzle Postgres handle: the script client, the backend pool, or a
 * transaction opened on either. The same shape `src/queries/**` takes.
 */
export type JobDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Runs one write batch in a transaction. A CLI passes nothing and gets
 * `db.transaction`; the background worker passes its attempt fence, so a batch
 * commits only while that attempt still owns the run.
 */
export type JobTransact = <Result>(callback: (transaction: JobDatabase) => Promise<Result>) => Promise<Result>;

/** Plain-text progress lines. Never pass credentials, SQL or provider responses. */
export type JobLogger = {
  info(message: string): void;
  warn(message: string): void;
};

/** What every job body takes. Reads go through `db`, writes through `transact`. */
export type JobRunOptions = {
  db: JobDatabase;
  signal: AbortSignal;
  transact?: JobTransact;
  log: JobLogger;
};

export function defaultTransact(db: JobDatabase): JobTransact {
  return (callback) => db.transaction((transaction) => callback(transaction));
}
