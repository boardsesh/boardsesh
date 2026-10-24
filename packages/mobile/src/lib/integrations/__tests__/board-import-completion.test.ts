import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

// query-provider imports AppState/Platform from react-native; mock it for the wiring test.
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' },
}));
vi.mock('../../error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../aurora-credentials', () => ({ getAuroraCredentials: vi.fn() }));

import { createQueryClient } from '../../../providers/query-provider';
import {
  boardsWithFinishedImport,
  watchBoardImportCompletion,
  type BoardImportState,
} from '../board-import-completion';
import {
  AURORA_CREDENTIALS_QUERY_KEY,
  AURORA_UNSYNCED_QUERY_KEY,
  PENDING_SYNC_REFRESH_MS,
  pendingSyncRefetchInterval,
} from '../use-board-account-credentials';

const syncing = (boardType: string): BoardImportState => ({ boardType, pendingRunId: 'run-1', lastSyncAt: null });
const synced = (boardType: string): BoardImportState => ({
  boardType,
  pendingRunId: null,
  lastSyncAt: '2026-10-24T01:00:00Z',
});

describe('boardsWithFinishedImport', () => {
  it('reports a board whose queued run cleared', () => {
    expect(boardsWithFinishedImport([syncing('kilter')], [synced('kilter')])).toEqual(['kilter']);
  });
  it('reports a board whose first lastSyncAt appeared', () => {
    const before = { boardType: 'tension', pendingRunId: null, lastSyncAt: null };
    expect(boardsWithFinishedImport([before], [synced('tension')])).toEqual(['tension']);
  });
  it('reports nothing when nothing changed', () => {
    expect(boardsWithFinishedImport([syncing('kilter')], [syncing('kilter')])).toEqual([]);
    expect(boardsWithFinishedImport([synced('kilter')], [synced('kilter')])).toEqual([]);
  });
  it('reports nothing on the first observation', () => {
    expect(boardsWithFinishedImport(undefined, [synced('kilter')])).toEqual([]);
  });
  it('reports nothing for a board that disappeared or just appeared', () => {
    expect(boardsWithFinishedImport([syncing('kilter')], [])).toEqual([]);
    expect(boardsWithFinishedImport([], [synced('kilter')])).toEqual([]);
  });
});

describe('watchBoardImportCompletion', () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    clients.splice(0).forEach((client) => client.clear());
  });

  function setup() {
    const queryClient = new QueryClient();
    clients.push(queryClient);
    const unsubscribe = watchBoardImportCompletion(queryClient);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const invalidatedRoots = () => spy.mock.calls.map(([filters]) => filters?.queryKey?.[0]);
    return { queryClient, unsubscribe, spy, invalidatedRoots };
  }
  const write = (queryClient: QueryClient, credentials: BoardImportState[]) =>
    queryClient.setQueryData(AURORA_CREDENTIALS_QUERY_KEY, { credentials });

  it('does not fire on the first observation (app start, already synced)', () => {
    const { queryClient, spy } = setup();
    write(queryClient, [synced('kilter')]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('invalidates the own-data keys once when an import finishes', () => {
    const { queryClient, spy, invalidatedRoots } = setup();
    write(queryClient, [syncing('kilter')]);
    expect(spy).not.toHaveBeenCalled();
    write(queryClient, [synced('kilter')]);
    expect(invalidatedRoots()).toEqual(
      expect.arrayContaining(['userTicks', 'userGroupedAscentsFeed', 'userProfileStats', 'userTickCountsByBoard']),
    );
    expect(invalidatedRoots()).not.toContain('auroraCredentials');
    const callsAfterFinish = spy.mock.calls.length;
    write(queryClient, [synced('kilter')]);
    expect(spy.mock.calls.length).toBe(callsAfterFinish);
  });

  it('ignores the unsynced-counts entry that shares the credentials prefix', () => {
    const { queryClient, spy } = setup();
    write(queryClient, [syncing('kilter')]);
    queryClient.setQueryData(AURORA_UNSYNCED_QUERY_KEY, { credentials: [synced('kilter')] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops watching after unsubscribe', () => {
    const { queryClient, unsubscribe, spy } = setup();
    write(queryClient, [syncing('kilter')]);
    unsubscribe();
    write(queryClient, [synced('kilter')]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is wired into createQueryClient', () => {
    const queryClient = createQueryClient();
    clients.push(queryClient);
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    write(queryClient, [syncing('kilter')]);
    write(queryClient, [synced('kilter')]);
    expect(spy.mock.calls.map(([filters]) => filters?.queryKey?.[0])).toContain('userTicks');
  });
});

describe('pendingSyncRefetchInterval', () => {
  const state = (credentials: BoardImportState[] | undefined) => ({
    state: { data: credentials && { credentials } },
  });
  it('polls every 20 s while a credential has a queued run', () => {
    expect(PENDING_SYNC_REFRESH_MS).toBe(20_000);
    expect(pendingSyncRefetchInterval(state([syncing('kilter')]) as never)).toBe(20_000);
  });
  it('stops polling when nothing is queued or there is no data', () => {
    expect(pendingSyncRefetchInterval(state([synced('kilter')]) as never)).toBe(false);
    expect(pendingSyncRefetchInterval(state(undefined) as never)).toBe(false);
  });
});
