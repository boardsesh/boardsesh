import type { PendingConsentDecision } from '@boardsesh/consent';
import { createIndexedDBStore } from './idb-helper';
const STORE = 'pending';
const getDB = createIndexedDBStore('boardsesh-analytics-consent', STORE);
export async function loadPendingConsent(accountId: string): Promise<PendingConsentDecision | null> {
  const database = await getDB();
  return database ? (((await database.get(STORE, accountId)) as PendingConsentDecision | undefined) ?? null) : null;
}
export async function persistPendingConsent(accountId: string, decision: PendingConsentDecision | null): Promise<void> {
  const database = await getDB();
  if (!database) return;
  if (decision) await database.put(STORE, decision, accountId);
  else await database.delete(STORE, accountId);
}
