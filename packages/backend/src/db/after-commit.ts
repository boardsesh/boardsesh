import { logger } from '../utils/logger';
import { db, queueDatabaseEffect } from './client';

// ============================================
// Effects that wait for the commit
// ============================================
//
// Some work a mutation does deep inside its transaction must not leave the
// process until that transaction has committed: an analytics event counted for
// a change that then rolls back is a count of something that never happened.
// The code that queues such an effect is often several calls away from the
// `db.transaction` that owns it (the directory-report hooks run from
// `recordBoardModerationEvent`), so the effect is queued on the transaction
// handle and run by the owner once `db.transaction` resolves.

/** A transaction handle, as `db.transaction` passes it. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type TransactionConfig = Parameters<typeof db.transaction>[1];
type AfterCommitEffect = () => void;

const effectsByTransaction = new WeakMap<object, AfterCommitEffect[]>();
let warnedAboutUnscopedTransaction = false;

/**
 * `db.transaction`, plus the effects its work queued with `afterCommit`, run
 * once it has committed. When the work throws, the transaction rolls back and
 * the effects are dropped.
 */
export async function transactionWithAfterCommit<T>(
  work: (tx: DbTransaction) => Promise<T>,
  config?: TransactionConfig,
): Promise<T> {
  const effects: AfterCommitEffect[] = [];
  const result = await db.transaction((tx) => {
    effectsByTransaction.set(tx, effects);
    return work(tx);
  }, config);
  for (const effect of effects) {
    if (queueDatabaseEffect(effect)) continue;
    try {
      effect();
    } catch (error) {
      // The change is committed; a failing side effect must not report it as failed.
      logger.warn('[afterCommit] An effect failed after the commit', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * Run `effect` once the work done on `executor` is committed: at the end of a
 * `transactionWithAfterCommit` transaction, or at once for `db` itself, whose
 * statements commit as they run.
 *
 * A transaction opened with plain `db.transaction` cannot be followed to its
 * end, so the effect runs at once there too, before the commit, and a warning
 * says so once per process. Open such a transaction with
 * `transactionWithAfterCommit` instead.
 */
export function afterCommit(executor: object, effect: AfterCommitEffect): void {
  const effects = effectsByTransaction.get(executor);
  if (effects) {
    effects.push(effect);
    return;
  }
  if (queueDatabaseEffect(effect)) return;
  if (executor !== db && !warnedAboutUnscopedTransaction) {
    warnedAboutUnscopedTransaction = true;
    logger.warn(
      '[afterCommit] An effect was queued inside a transaction not opened with transactionWithAfterCommit; it ran before the commit',
    );
  }
  effect();
}
