// Re-export db client from @boardsesh/db
import { createDb, createReadDb } from '@boardsesh/db/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '../utils/logger';

// Singleton primary client for the backend (writes + auth + party-mode reads).
const primaryDb = createDb();

// Singleton replica-aware client for read-heavy paths (search, feed,
// analytics). Falls back to the primary when READ_REPLICA_URL is unset.
const readDb = createReadDb();

export type Database = typeof primaryDb;
export type DatabaseEffect = () => void | Promise<void>;
export type DatabaseTransactionOptions = Pick<NonNullable<Parameters<Database['transaction']>[1]>, 'isolationLevel'>;

interface DatabaseScope {
  executor: Database;
  effects: DatabaseEffect[];
  active: boolean;
  isolationLevel: NonNullable<DatabaseTransactionOptions['isolationLevel']>;
}

const databaseScope = new AsyncLocalStorage<DatabaseScope>();

/** Existing resolvers keep their executor while a delegated write holds its authorization locks. */
function scopedDatabase(fallback: Database): Database {
  return new Proxy(fallback, {
    get(target, property) {
      const scope = databaseScope.getStore();
      const executor = scope?.active ? scope.executor : target;
      if (property === 'transaction' && scope?.active) {
        const scopedTransaction: Database['transaction'] = async (work, config) => {
          const effectCheckpoint = scope.effects.length;
          try {
            return await executor.transaction(async (nestedTransaction) => {
              const nestedScope: DatabaseScope = {
                executor: nestedTransaction as unknown as Database,
                effects: scope.effects,
                active: true,
                isolationLevel: scope.isolationLevel,
              };
              try {
                return await databaseScope.run(nestedScope, () => work(nestedTransaction));
              } finally {
                nestedScope.active = false;
              }
            }, config);
          } catch (error) {
            // A caller may catch a failed savepoint and still commit its outer work.
            scope.effects.splice(effectCheckpoint);
            throw error;
          }
        };
        return scopedTransaction;
      }
      const member: unknown = Reflect.get(executor, property);
      return typeof member === 'function' ? member.bind(executor) : member;
    },
  });
}

export const db = scopedDatabase(primaryDb);
export const dbRead = scopedDatabase(readDb);

/** Queue an external effect only inside an active delegated transaction. */
export function queueDatabaseEffect(effect: DatabaseEffect): boolean {
  const scope = databaseScope.getStore();
  if (!scope?.active) return false;
  scope.effects.push(effect);
  return true;
}

export async function deferDatabaseEffect(effect: DatabaseEffect): Promise<void> {
  if (!queueDatabaseEffect(effect)) await effect();
}

/**
 * Run normal resolver writes, including their savepoints, in one outer transaction.
 * Revocation locks and mutation receipts belong to this transaction too. Effects
 * run only after commit; escaped asynchronous work cannot use a finished handle.
 */
export async function runWithDatabaseTransaction<Result>(
  work: (executor: Database) => Promise<Result>,
  options?: DatabaseTransactionOptions,
): Promise<Result> {
  const parent = databaseScope.getStore();
  if (parent?.active) {
    if (options?.isolationLevel && options.isolationLevel !== parent.isolationLevel) {
      throw new Error('A delegated transaction cannot change its existing isolation level.');
    }
    return work(parent.executor);
  }
  const effects: DatabaseEffect[] = [];
  const result = await primaryDb.transaction(async (transaction) => {
    const executor = transaction as unknown as Database;
    const scope: DatabaseScope = {
      executor,
      effects,
      active: true,
      isolationLevel: options?.isolationLevel ?? 'read committed',
    };
    try {
      return await databaseScope.run(scope, () => work(executor));
    } finally {
      scope.active = false;
    }
  }, options);
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      // The database already committed. A notification failure cannot undo it.
      logger.warn('Delegated database effect failed after commit', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return result;
}
