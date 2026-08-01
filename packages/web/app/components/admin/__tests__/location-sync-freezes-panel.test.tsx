import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FrozenLocationSyncEntity } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import LocationSyncFreezesPanel from '../location-sync-freezes-panel';

const mockRequest = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'admin-token' }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  FROZEN_LOCATION_SYNC_ENTITIES: 'FROZEN_LOCATION_SYNC_ENTITIES',
  CLEAR_LOCATION_SYNC_FREEZE: 'CLEAR_LOCATION_SYNC_FREEZE',
}));

const frozenGym: FrozenLocationSyncEntity = {
  entityType: 'GYM',
  entityUuid: '9db20aac-59aa-4e03-96a5-e1cd51f25cac',
  slug: 'locked-gym',
  name: 'Locked Gym',
  boardType: null,
  isSystemOwned: false,
  ownerProtected: true,
  isDeleted: true,
  deletedAt: '2026-07-31T12:00:00.000Z',
  syncFrozenAt: '2026-08-01T01:02:03.000Z',
  sourceKeys: [],
};

const frozenBoard: FrozenLocationSyncEntity = {
  entityType: 'BOARD',
  entityUuid: '2662b7c4-ae9d-4d4c-853f-7988f464a26b',
  slug: 'current-board',
  name: 'Current Board Result',
  boardType: 'tension',
  isSystemOwned: true,
  ownerProtected: false,
  isDeleted: false,
  deletedAt: null,
  syncFrozenAt: '2026-08-01T04:05:06.000Z',
  sourceKeys: [],
};

function connection(entities: FrozenLocationSyncEntity[] = [frozenGym]) {
  return {
    frozenLocationSyncEntities: {
      entities,
      totalCount: entities.length,
      hasMore: false,
    },
  };
}

function deferred<Response>() {
  let resolvePromise!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('LocationSyncFreezesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows recovery warnings and sends the confirmed freeze timestamp with an audit reason', async () => {
    mockRequest
      .mockResolvedValueOnce(connection())
      .mockResolvedValueOnce({
        clearLocationSyncFreeze: {
          status: 'CLEARED',
          entityType: 'GYM',
          entityUuid: frozenGym.entityUuid,
          previousSyncFrozenAt: frozenGym.syncFrozenAt,
        },
      })
      .mockResolvedValueOnce(connection([]));

    render(<LocationSyncFreezesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Release freeze' }));

    expect(
      screen.getByText('This listing is deleted. A matching source can bring it back on the next sync.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'This gym has a user owner or an approved claim. The ownership guard remains active after the freeze is released.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'No sync source is currently linked to this gym. Releasing the freeze will have no effect until a source matches it.',
      ),
    ).toBeTruthy();

    const reasonInput = screen.getByLabelText('Reason');
    fireEvent.change(reasonInput, { target: { value: 'short' } });
    expect(screen.getAllByRole('button', { name: 'Release freeze' }).at(-1)?.hasAttribute('disabled')).toBe(true);

    fireEvent.change(reasonInput, { target: { value: '  Confirmed upstream recovery  ' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Release freeze' }).at(-1)!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('CLEAR_LOCATION_SYNC_FREEZE', {
        input: {
          entityType: 'GYM',
          entityUuid: frozenGym.entityUuid,
          expectedSyncFrozenAt: frozenGym.syncFrozenAt,
          reason: 'Confirmed upstream recovery',
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('Locked Gym')).toBeNull();
    });
    expect(screen.getByText('Sync freeze released')).toBeTruthy();
  });

  it('refreshes the list after a stale or failed release', async () => {
    mockRequest
      .mockResolvedValueOnce(connection())
      .mockRejectedValueOnce(new Error('LOCATION_SYNC_FREEZE_STALE'))
      .mockResolvedValueOnce(connection([]));

    render(<LocationSyncFreezesPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'Release freeze' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Another edit changed the marker' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Release freeze' }).at(-1)!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByText("Couldn't release the sync freeze. The list has been refreshed.")).toBeTruthy();
    expect(await screen.findByText('No frozen listings match this search.')).toBeTruthy();
  });

  it('ignores a list refresh that resolves after a successful release', async () => {
    const staleRefresh = deferred<ReturnType<typeof connection>>();
    const reconciledRefresh = deferred<ReturnType<typeof connection>>();
    mockRequest
      .mockResolvedValueOnce(connection())
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce({
        clearLocationSyncFreeze: {
          status: 'CLEARED',
          entityType: 'GYM',
          entityUuid: frozenGym.entityUuid,
          previousSyncFrozenAt: frozenGym.syncFrozenAt,
        },
      })
      .mockReturnValueOnce(reconciledRefresh.promise);

    render(<LocationSyncFreezesPanel />);

    expect(await screen.findByText('Locked Gym')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Release freeze' }));
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Confirmed safe upstream restoration' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Release freeze' }).at(-1)!);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(4);
    });
    expect(screen.queryByText('Locked Gym')).toBeNull();

    await act(async () => {
      staleRefresh.resolve(connection([frozenGym]));
      await staleRefresh.promise;
    });
    expect(screen.queryByText('Locked Gym')).toBeNull();

    await act(async () => {
      reconciledRefresh.resolve(connection([]));
      await reconciledRefresh.promise;
    });
    expect(await screen.findByText('No frozen listings match this search.')).toBeTruthy();
  });

  it('requests boards when the board tab is selected', async () => {
    mockRequest.mockResolvedValue(connection([]));

    render(<LocationSyncFreezesPanel />);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('FROZEN_LOCATION_SYNC_ENTITIES', {
        input: { entityType: 'GYM', query: undefined, limit: 20, offset: 0 },
      });
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Boards' }));

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('FROZEN_LOCATION_SYNC_ENTITIES', {
        input: { entityType: 'BOARD', query: undefined, limit: 20, offset: 0 },
      });
    });
  });

  it('ignores a stale gym response that resolves after the board tab response', async () => {
    const gymResponse = deferred<ReturnType<typeof connection>>();
    const boardResponse = deferred<ReturnType<typeof connection>>();
    mockRequest.mockReturnValueOnce(gymResponse.promise).mockReturnValueOnce(boardResponse.promise);

    render(<LocationSyncFreezesPanel />);

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Boards' }));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      boardResponse.resolve(connection([frozenBoard]));
      await boardResponse.promise;
    });
    expect(await screen.findByText('Current Board Result')).toBeTruthy();

    await act(async () => {
      gymResponse.resolve(connection([frozenGym]));
      await gymResponse.promise;
    });
    expect(screen.getByText('Current Board Result')).toBeTruthy();
    expect(screen.queryByText('Locked Gym')).toBeNull();
  });
});
