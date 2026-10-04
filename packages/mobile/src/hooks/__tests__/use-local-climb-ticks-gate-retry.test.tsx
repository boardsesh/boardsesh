// @vitest-environment jsdom
// A drawer opened before the first sync finishes gets no local rows: the
// completeness gate declines. That answer must not stick for the session.
//
// Runs the hook under the real React Query, which needs a DOM, and node:sqlite
// does not load there. So the database is a stand-in that answers the two reads
// the hook makes; the SQL itself is covered in use-local-climb-ticks.test.ts.
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LOCAL_USER_ID_KEY, USER_DATA_COMPLETE_KEY } from '@boardsesh/offline-sync';

const device = vi.hoisted(() => ({
  syncMeta: new Map<string, string>(),
  tickReads: 0,
}));

vi.mock('../../db', () => ({
  getDatabaseHandle: () => ({
    // Every `sync_meta` read the gate makes is a lookup by key.
    getFirstAsync: async (_sql: string, [key]: string[]) =>
      device.syncMeta.has(key) ? { key, value: device.syncMeta.get(key) } : null,
    getAllAsync: async () => {
      device.tickReads += 1;
      return [
        {
          uuid: 'tick-1',
          angle: 40,
          is_mirror: 0,
          status: 'send',
          attempt_count: 2,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2026-05-30T10:00:00.000Z',
        },
      ];
    },
  }),
}));
vi.mock('../../providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock('../use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'user-a', isLoading: false }),
}));

import { localClimbTicksQueryKey, useLocalClimbTicks } from '../use-local-climb-ticks';

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

const openDrawer = (wrapper: ReturnType<typeof createHarness>['wrapper']) =>
  renderHook(() => useLocalClimbTicks('kilter', 'climb-1', true), { wrapper });

beforeEach(() => {
  device.syncMeta = new Map([[LOCAL_USER_ID_KEY, 'user-a']]);
  device.tickReads = 0;
});

describe('useLocalClimbTicks, once the gate opens', () => {
  it('shows the rows on the next open of a climb first opened before the sync finished', async () => {
    const { client, wrapper } = createHarness();
    const key = localClimbTicksQueryKey('climb-1', 'kilter', 'user-a');

    // First open: the user tables have not reached their tail yet.
    const firstOpen = openDrawer(wrapper);
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('success'));
    expect(firstOpen.result.current).toBeUndefined();
    expect(device.tickReads).toBe(0);
    firstOpen.unmount();

    device.syncMeta.set(USER_DATA_COMPLETE_KEY, '1');

    const secondOpen = openDrawer(wrapper);
    await waitFor(() => expect(secondOpen.result.current?.map((entry) => entry.uuid)).toEqual(['tick-1']));
  });

  it('does not read the table again on every open once it has rows', async () => {
    device.syncMeta.set(USER_DATA_COMPLETE_KEY, '1');
    const { wrapper } = createHarness();

    const firstOpen = openDrawer(wrapper);
    await waitFor(() => expect(firstOpen.result.current).toHaveLength(1));
    firstOpen.unmount();

    const secondOpen = openDrawer(wrapper);
    expect(secondOpen.result.current).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(device.tickReads).toBe(1);
  });
});
