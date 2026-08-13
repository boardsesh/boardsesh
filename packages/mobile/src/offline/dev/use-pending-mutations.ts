// Dev-only outbox inspector (issue #4315).
//
// The More tab's "Sync issues" section only renders when `!isOffline &&
// deadLetterCount > 0`, and it lists dead letters — so nothing in the app shows
// a PENDING row, which is exactly what the tick degrade produces and exactly
// what QA has to see, offline, to know the send survived. This is the read
// behind that list.

import { useQuery } from '@tanstack/react-query';
import type { OfflineDatabase } from '@boardsesh/offline-sync';

export type PendingMutationRow = {
  id: number;
  table_name: string;
  operation: string;
  idempotency_key: string;
  status: string;
  retry_count: number;
  created_at: string;
};

/** Newest 50 outbox rows, whatever their status. Refetched on focus by the caller. */
export function usePendingMutations(db: OfflineDatabase | null) {
  return useQuery({
    queryKey: ['dev', 'pendingMutations'],
    enabled: db !== null,
    queryFn: async (): Promise<PendingMutationRow[]> => {
      if (!db) return [];
      return db.getAllAsync<PendingMutationRow>(
        `SELECT id, table_name, operation, idempotency_key, status, retry_count, created_at
         FROM pending_mutations ORDER BY id DESC LIMIT 50`,
        [],
      );
    },
    staleTime: 0,
  });
}
