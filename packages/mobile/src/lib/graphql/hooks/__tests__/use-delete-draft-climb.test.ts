// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { runMigrations, enqueue, climbMutationEntityKey } from '@boardsesh/offline-sync';
import { createTestDatabase, __resetDrainerStateForTests, type TestSqliteDb } from '@boardsesh/offline-sync/testing';

const invalidateQueries = vi.fn(async (_filters?: { queryKey?: readonly unknown[] }) => {});
const request = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({
    request: ({ document, variables }: { document: unknown; variables?: unknown }) => request(document, variables),
  }),
  getOfflineSyncHttpClient: vi.fn(),
}));
let db: TestSqliteDb;
vi.mock('../../../../db', () => ({ getDatabaseHandle: () => db }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../offline-engine', () => ({ isOfflineEngineEnabled: () => true }));
vi.mock('../../../error-reporting', () => ({ reportHandledError: vi.fn() }));
import { useDeleteDraftClimb } from '../use-delete-draft-climb';

const clients: QueryClient[] = [];
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  vi.spyOn(client, 'invalidateQueries').mockImplementation(invalidateQueries);
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(useDeleteDraftClimb, { wrapper });
}

beforeEach(async () => {
  invalidateQueries.mockClear();
  request.mockReset();
  __resetDrainerStateForTests();
  // Each existing business case owns an in-memory SQLite fixture, never user storage.
  db = createTestDatabase();
  await runMigrations(db);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('downloaded draft deletion', () => {
  const variables = { uuid: 'spray-draft', boardType: 'spray' };

  it('removes the downloaded draft before the final list invalidation', async () => {
    await db.runAsync(
      "INSERT INTO board_climbs (uuid, board_type, layout_id, is_draft) VALUES ('spray-draft', 'spray', 42, 1)",
    );
    let release!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ deleteDraftClimb: true });
        }),
    );
    const hook = setup();
    let pending!: Promise<unknown>;
    act(() => {
      pending = hook.result.current.mutateAsync(variables);
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', [variables.uuid])).not.toBeNull();
    await act(async () => {
      release();
      await pending;
    });
    await vi.waitFor(async () => {
      expect(await db.getFirstAsync('SELECT uuid FROM board_climbs WHERE uuid = ?', [variables.uuid])).toBeNull();
      expect(
        invalidateQueries.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'searchClimbs'),
      ).toHaveLength(2);
    });
  });

  it.each(['pending', 'dead_letter'])('refuses deletion with a %s climb write', async (status) => {
    await enqueue(db, 'board_climbs', 'update', {}, 'climb-edit', {
      entityKey: climbMutationEntityKey('spray', variables.uuid),
    });
    await db.runAsync('UPDATE pending_mutations SET status = ?', [status]);
    const hook = setup();
    await expect(hook.result.current.mutateAsync(variables)).rejects.toThrow('Sync your saved climb');
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['pending', 'dead_letter'])('refuses deletion while a %s draft tick can still be synced', async (status) => {
    await enqueue(db, 'boardsesh_ticks', 'create', { boardType: 'spray', climbUuid: variables.uuid }, 'queued-tick');
    await db.runAsync('UPDATE pending_mutations SET status = ?', [status]);
    const hook = setup();
    await expect(hook.result.current.mutateAsync(variables)).rejects.toMatchObject({
      extensions: { code: 'CLIMB_HAS_TICKS' },
    });
    expect(request).not.toHaveBeenCalled();
  });
});
