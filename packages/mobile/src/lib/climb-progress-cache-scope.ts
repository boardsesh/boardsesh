import type { QueryClient } from '@tanstack/react-query';

/**
 * Logbook keys are shared by board, rather than account. Remember which
 * credential owned each query object, so a remounted loader cannot re-publish
 * the old accumulated cache while native sign-out is still clearing storage.
 * Removing a query retires that identity; its replacement belongs to the new
 * scope. No latch or timer is needed.
 */
export function createClimbProgressCacheScope(queryClient: QueryClient, generation: number) {
  const owners = new WeakMap<object, number>();
  let currentGeneration = generation;
  const claimExisting = () => {
    for (const query of queryClient.getQueryCache().findAll({ queryKey: ['logbook'] })) {
      if (!owners.has(query)) owners.set(query, currentGeneration);
    }
  };
  const hasAccountRead = (boardName: unknown) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ['logbook', boardName] })
      .some((query) => {
        const kind = query.queryKey[2];
        if (kind === 'accumulated') return !Array.isArray(query.state.data) || query.state.data.length > 0;
        if (kind === 'fetched-climb-uuids') return query.state.data instanceof Set && query.state.data.size > 0;
        // A nonempty fetch key is evidence of an authenticated read, including
        // one whose account-A answer has not reached the empty accumulator yet.
        if (kind === 'fetch') return query.queryKey[3] !== '';
        return true;
      });
  claimExisting();
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === 'logbook' && event.type === 'added') owners.set(event.query, currentGeneration);
  });
  return {
    unsubscribe,
    setGeneration(nextGeneration: number) {
      // Claim before switching, including queries created since the last render.
      claimExisting();
      if (nextGeneration !== currentGeneration) {
        for (const query of queryClient.getQueryCache().findAll({ queryKey: ['logbook'] })) {
          if (query.queryKey[2] === 'accumulated' && !hasAccountRead(query.queryKey[1])) {
            // useLogbook creates an empty disabled accumulator before login.
            // It can be filled by the new credentials without being removed.
            // Never transfer an identity that had a pending account read.
            owners.set(query, nextGeneration);
          }
        }
      }
      currentGeneration = nextGeneration;
    },
    belongsToCurrentScope(boardName: string) {
      const query = queryClient.getQueryCache().find({ queryKey: ['logbook', boardName, 'accumulated'], exact: true });
      return !query || owners.get(query) === currentGeneration;
    },
  };
}
