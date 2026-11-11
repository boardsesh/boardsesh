import {
  parseAccountConsolidationReceipt,
  type AccountConsolidationReceipt,
} from '@boardsesh/auth-protocol/account-consolidation';
import {
  transitionConsolidatedOwner,
  type ConsolidationTransitionJournal,
} from '@boardsesh/auth-protocol/account-consolidation-transition';
import { beginGlobalPurge, setSigningOut } from '@boardsesh/offline-sync';
import { clearUserData, getDatabaseHandle } from '../db';

export function setOnAccountConsolidated(_callback: (() => void) | null): void {}
export async function resumePendingAccountConsolidation(): Promise<void> {}

/** Cookies stay HttpOnly. Only the receipt and local transaction journal enter SQLite. */
export async function reconcileBrowserAccountConsolidation(
  receipt: AccountConsolidationReceipt,
  generation: number,
  epochs: { isCurrent(generation: number): boolean; advanceEpoch(generation: number): number | null },
): Promise<number | null> {
  const database = getDatabaseHandle();
  if (!database) throw new Error('Consolidation database unavailable');
  const owner = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    'local_user_id',
  ]);
  if (!epochs.isCurrent(generation)) return null;
  const completed = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
    'account_consolidation_completed',
  ]);
  if (owner?.value === receipt.toUserId && completed?.value === receipt.mergeId) return generation;
  if (owner?.value !== receipt.fromUserId) {
    // A new install with no old local work needs no ownership reassignment.
    const pending = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_mutations');
    if (!owner && pending?.count === 0) return generation;
    throw new Error('Consolidation local owner mismatch');
  }
  let activeGeneration = generation;
  let pauseOwner: number | null = null;
  const readJournal = async (): Promise<ConsolidationTransitionJournal | null> => {
    const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_meta WHERE key = ?', [
      'account_consolidation_journal',
    ]);
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.value);
    const journal = parseAccountConsolidationReceipt(parsed, receipt.fromUserId, receipt.toUserId);
    if (
      !journal ||
      typeof parsed !== 'object' ||
      parsed === null ||
      !('phase' in parsed) ||
      (parsed.phase !== 'prepared' && parsed.phase !== 'credentials-published')
    )
      throw new Error('Invalid consolidation journal');
    return { ...journal, phase: parsed.phase };
  };
  const writeJournal = async (journal: ConsolidationTransitionJournal, current: number) => {
    let written = false;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      if (!epochs.isCurrent(current)) return;
      await transaction.runAsync('INSERT OR REPLACE INTO sync_meta(key,value) VALUES(?,?)', [
        'account_consolidation_journal',
        JSON.stringify(journal),
      ]);
      if (!epochs.isCurrent(current)) throw new Error('Consolidation credential owner changed');
      written = true;
    });
    return written;
  };
  let result: 'completed' | 'superseded';
  try {
    result = await transitionConsolidatedOwner(receipt, {
      captureOwner: () => ({ userId: owner.value, generation }),
      advanceEpoch(expected) {
        const next = epochs.advanceEpoch(expected);
        if (next !== null) activeGeneration = next;
        return next;
      },
      isCurrent: (current) => epochs.isCurrent(current),
      async pauseAndDrain(current) {
        if (!epochs.isCurrent(current)) return false;
        pauseOwner = current;
        beginGlobalPurge();
        setSigningOut(true);
        return true;
      },
      stageCredentials: (candidate, current) => writeJournal({ ...candidate, phase: 'prepared' }, current),
      readJournal,
      writeJournal,
      async publishCredentials(current) {
        return epochs.isCurrent(current);
      },
      async commitLocalOwnership(journal, current) {
        await clearUserData(database, {
          fromUserId: journal.fromUserId,
          toUserId: journal.toUserId,
          completedMergeId: journal.mergeId,
          isCurrent: () => epochs.isCurrent(current),
        });
        return epochs.isCurrent(current);
      },
      async resume(current) {
        if (pauseOwner === current && epochs.isCurrent(current)) {
          pauseOwner = null;
          setSigningOut(false);
        }
      },
    });
  } catch (error) {
    if (pauseOwner === activeGeneration && epochs.isCurrent(activeGeneration) && (await readJournal()) === null) {
      pauseOwner = null;
      setSigningOut(false);
    }
    throw error;
  }
  return result === 'completed' ? activeGeneration : null;
}
