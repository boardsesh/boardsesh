// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

// The real react-native entry is Flow source Rolldown can't parse; stub the two
// members QueryProvider touches. The AppState listener is captured so the
// background-flush contract can be exercised.
const appStateState = vi.hoisted(() => ({ listener: null as ((status: string) => void) | null }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      appStateState.listener = listener;
      return { remove: () => {} };
    },
  },
  Platform: { OS: 'ios' },
}));

// A per-id MMKV mock so the seeded blob is genuinely in the query-cache
// instance (the shared stub shares one map across every id).
const instances = vi.hoisted(() => new Map<string, Map<string, string>>());
vi.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const store = instances.get(id) ?? new Map<string, string>();
    instances.set(id, store);
    return {
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => {
        store.set(key, value);
      },
      remove: (key: string) => {
        store.delete(key);
      },
      clearAll: () => {
        store.clear();
      },
    };
  },
}));

// The analytics barrel reaches posthog-react-native; FeatureFlagsProvider is
// what imports these two readers from it.
vi.mock('../../lib/analytics', () => ({
  readPosthogFeatureFlags: () => ({}),
  subscribePosthogFeatureFlags: () => () => {},
}));

import { QueryProvider } from '../query-provider';
import { FeatureFlagsProvider } from '../feature-flags-provider';
import { PERSISTED_CACHE_VERSION, serializePersistedCache, type PersistedQueryEntry } from '../../lib/query-persist';
import { getPersistOwner, resetQueryPersistRuntime, setPersistOwner } from '../../lib/query-persist';

const OWNER = 'user-1';
const CACHE_STORE_ID = 'boardsesh-query-cache';

const SEEDED_AT = Date.now();

function persistedEntry(queryKey: readonly unknown[], data: unknown): PersistedQueryEntry {
  return {
    queryHash: JSON.stringify(queryKey),
    queryKey: queryKey as unknown[],
    state: { data, dataUpdatedAt: SEEDED_AT, status: 'success', fetchStatus: 'idle' },
  } as unknown as PersistedQueryEntry;
}

const ALL_ALLOWLISTED_ENTRIES: readonly (readonly [readonly unknown[], unknown])[] = [
  [['profile'], { id: OWNER, name: 'Marco' }],
  [['myBoards', null], [{ uuid: 'board-1' }]],
  [['myGyms'], [{ id: 'gym-1' }]],
  [['grades', 'kilter'], [{ difficultyId: 10 }]],
  [
    ['angles', 'kilter', 8],
    [40, 45],
  ],
  [['publicProfile', OWNER], { id: OWNER }],
];

function seedBlob(userId: string, entries: readonly (readonly [readonly unknown[], unknown])[]): void {
  const store = instances.get(CACHE_STORE_ID) ?? new Map<string, string>();
  instances.set(CACHE_STORE_ID, store);
  store.set(
    'queryCacheV1',
    serializePersistedCache({
      version: PERSISTED_CACHE_VERSION,
      userId,
      savedAt: SEEDED_AT,
      queries: entries.map(([queryKey, data]) => persistedEntry(queryKey, data)),
    }),
  );
  store.set('queryCacheOwnerV1', userId);
}

let firstRenderProfile: unknown = 'not-rendered';
let capturedClient: QueryClient | null = null;

function ProfileProbe() {
  const client = useQueryClient();
  capturedClient = client;
  // Read during RENDER, not in an effect: this is what "no isRestoring frame"
  // means — the first render pass already sees the persisted profile.
  if (firstRenderProfile === 'not-rendered') firstRenderProfile = client.getQueryData(['profile']);
  return null;
}

beforeEach(() => {
  for (const store of instances.values()) store.clear();
  resetQueryPersistRuntime();
  appStateState.listener = null;
  firstRenderProfile = 'not-rendered';
  capturedClient = null;
});

// T-20
describe('QueryProvider persisted-cache restore', () => {
  it('has the persisted profile in the cache on the very first render pass', () => {
    seedBlob(OWNER, ALL_ALLOWLISTED_ENTRIES);

    render(
      <QueryProvider>
        <ProfileProbe />
      </QueryProvider>,
    );

    expect(firstRenderProfile).toEqual({ id: OWNER, name: 'Marco' });
  });

  it('hydrates nothing when the owner sentinel is missing', () => {
    seedBlob(OWNER, ALL_ALLOWLISTED_ENTRIES);
    instances.get(CACHE_STORE_ID)?.delete('queryCacheOwnerV1');

    render(
      <QueryProvider>
        <ProfileProbe />
      </QueryProvider>,
    );

    expect(firstRenderProfile).toBeUndefined();
  });

  // T-18 (narrowed to QueryProvider + FeatureFlagsProvider, per the plan's own
  // escape hatch: the rest of the pre-auth stack needs the offline-sync-bridge
  // mock recipe, and T-17's source-graph guard is the durable check). Mounting
  // pre-auth providers over a hydrated cache must not observe, refetch, or
  // otherwise touch a single allowlisted entry — `AppLoadingSplash` gates
  // AuthProvider's children, not its siblings' effects.
  it('leaves every hydrated entry untouched while pre-auth providers mount', async () => {
    seedBlob(OWNER, ALL_ALLOWLISTED_ENTRIES);

    render(
      <QueryProvider>
        <FeatureFlagsProvider flags={{ 'offline-board-downloads': true }}>
          <ProfileProbe />
        </FeatureFlagsProvider>
      </QueryProvider>,
    );
    await new Promise((resolveTick) => setTimeout(resolveTick, 0));

    const client = capturedClient;
    expect(client).not.toBeNull();
    for (const [queryKey] of ALL_ALLOWLISTED_ENTRIES) {
      const cached = client?.getQueryCache().find({ queryKey: queryKey as unknown[] });
      expect(cached, `${JSON.stringify(queryKey)} disappeared`).toBeDefined();
      // No observer means nothing up here subscribed; an untouched
      // `dataUpdatedAt` means nothing refetched or overwrote it either.
      expect(cached?.getObserversCount()).toBe(0);
      expect(cached?.state.fetchStatus).toBe('idle');
      expect(cached?.state.dataUpdatedAt).toBe(SEEDED_AT);
    }
  });

  it('writes on background only once an owner is armed', () => {
    render(
      <QueryProvider>
        <ProfileProbe />
      </QueryProvider>,
    );

    capturedClient?.setQueryData(['profile'], { id: OWNER, name: 'Marco' });
    // Backgrounded while signed out: the owner gate makes this a no-op.
    appStateState.listener?.('background');
    expect(instances.get(CACHE_STORE_ID)?.get('queryCacheV1')).toBeUndefined();

    setPersistOwner(OWNER);
    expect(getPersistOwner()).toBe(OWNER);
    appStateState.listener?.('background');
    expect(instances.get(CACHE_STORE_ID)?.get('queryCacheV1')).toContain('"profile"');
  });
});
