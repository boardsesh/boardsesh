import { describe, it, expect, afterEach } from 'vitest';
import { QueryClient, dehydrate, onlineManager } from '@tanstack/react-query';
import { dehydrateAllowlisted } from '../dehydrate';

afterEach(() => {
  onlineManager.setOnline(true);
});

const OWNER = 'user-1';

function heads(entries: readonly { queryKey: readonly unknown[] }[]): string[] {
  return entries.map((entry) => String(entry.queryKey[0])).sort();
}

describe('dehydrateAllowlisted', () => {
  // T-04: the hard-coded `shouldDehydrateMutation: () => false`. Asserted
  // against a client whose mutation query-core's own default WOULD dehydrate
  // (a paused mutation), so the test fails if the option is ever loosened.
  it('dehydrates zero mutations from a client holding a paused mutation', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient({ defaultOptions: { mutations: { networkMode: 'online', retry: false } } });
    const mutation = client.getMutationCache().build(client, { mutationFn: async () => 'ok' });
    // Never awaited: while offline this mutation stays paused, which is exactly
    // the state query-core's default `shouldDehydrateMutation` persists.
    void mutation.execute(undefined).catch(() => {});
    await Promise.resolve();

    // Sanity: query-core's default dehydrate does keep this one, so the
    // assertion below is about our option and not about an empty cache.
    expect(dehydrate(client).mutations.length).toBeGreaterThan(0);

    const state = dehydrate(client, {
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: () => false,
    });
    expect(state.mutations).toEqual([]);
    // The exported helper returns queries only — there is nowhere for a
    // mutation to go.
    expect(dehydrateAllowlisted(client, OWNER)).toEqual([]);
  });

  // T-06
  it('keeps only successful, idle, allowlisted entries', async () => {
    const client = new QueryClient();
    client.setQueryData(['profile'], { id: OWNER });
    client.setQueryData(['myBoards', undefined], [{ uuid: 'board-1' }]);
    client.setQueryData(['myGyms'], [{ id: 'gym-1' }]);
    client.setQueryData(['grades', 'kilter'], [{ difficultyId: 10 }]);
    client.setQueryData(['angles', 'kilter', 8], [40, 45]);
    client.setQueryData(['publicProfile', OWNER], { id: OWNER });
    // Not allowlisted: SQLite owns it.
    client.setQueryData(['infiniteSearchClimbs', { query: 'x' }], { pages: [] });
    // Not allowlisted: someone else's public profile.
    client.setQueryData(['publicProfile', 'stranger'], { id: 'stranger' });

    expect(heads(dehydrateAllowlisted(client, OWNER))).toEqual([
      'angles',
      'grades',
      'myBoards',
      'myGyms',
      'profile',
      'publicProfile',
    ]);
  });

  it('excludes errored and in-flight allowlisted entries', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client
      .fetchQuery({
        queryKey: ['myGyms'],
        queryFn: async () => {
          throw new Error('nope');
        },
      })
      .catch(() => {});
    // Never settles: stays `pending`/`fetching`, which is also the state that
    // makes query-core attach a non-serializable `promise`.
    void client.prefetchQuery({ queryKey: ['grades', 'kilter'], queryFn: () => new Promise(() => {}) });

    const entries = dehydrateAllowlisted(client, OWNER);
    expect(entries).toEqual([]);
  });
});
