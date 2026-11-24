// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCredentialGeneration, invalidateCredentialSnapshots } from '../../privacy/privacy-cache';
import { climbPlayCountKey } from '../../climb-play-count';
import type { LocalPlaysRow } from '../../../db/queries/get-climb-plays-local';
import { usePlaylistLocalPlays } from '../use-playlist-local-plays';

const control = vi.hoisted(() => ({
  handle: { name: 'db-one' },
  owner: 'account-one',
  download: ['kilter:1:10'],
  counts: vi.fn<() => Promise<LocalPlaysRow[]>>(),
  ownership: vi.fn(),
}));
vi.mock('@boardsesh/offline-sync', async (load) => ({
  ...(await load<typeof import('@boardsesh/offline-sync')>()),
  assertLocalUserDataOwner: control.ownership,
}));
vi.mock('../../../db', () => ({ getDatabaseHandle: () => control.handle }));
vi.mock('../../../db/queries/get-climb-plays-local', () => ({ getClimbPlaysLocal: control.counts }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: control.owner, isLoading: false }),
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: control.download }),
}));
vi.mock('../../../settings', () => ({ useSetting: () => [control.download] }));
vi.mock('../../local-user-id', () => ({ readLocalUserId: () => Promise.resolve(control.owner) }));

const targets = [{ boardName: 'kilter', layoutId: 1, climbUuid: 'same-climb', angle: 40 }];
const key = climbPlayCountKey('kilter', 1, 'same-climb', 40);

function wrapperWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('downloaded playlist Plays ownership', () => {
  beforeEach(() => {
    control.handle = { name: 'db-one' };
    control.owner = 'account-one';
    control.counts.mockReset();
    control.ownership.mockReset().mockResolvedValue('ok');
  });

  it('ignores an old account’s in-flight result and shows the new account’s exact zero', async () => {
    let resolveOldRead: ((rows: LocalPlaysRow[]) => void) | undefined;
    control.counts
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldRead = resolve;
          }),
      )
      .mockResolvedValueOnce([{ climbUuid: 'same-climb', angle: 40, playCount: 0 }]);
    const { result } = renderHook(() => usePlaylistLocalPlays(targets), { wrapper: wrapperWithClient() });
    await waitFor(() => expect(resolveOldRead).toBeTypeOf('function'));

    act(() => {
      control.owner = 'account-two';
      invalidateCredentialSnapshots();
    });
    await waitFor(() => expect(result.current.get(key)?.playCount).toBe(0));
    await act(async () => resolveOldRead?.([{ climbUuid: 'same-climb', angle: 40, playCount: 28 }]));
    expect(result.current.get(key)).toMatchObject({ playCount: 0, credentialScope: getCredentialGeneration() });
  });

  it('discards a result held across database-handle replacement', async () => {
    let resolveOldRead: ((rows: LocalPlaysRow[]) => void) | undefined;
    control.counts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldRead = resolve;
        }),
    );
    const { result } = renderHook(() => usePlaylistLocalPlays(targets), { wrapper: wrapperWithClient() });
    await waitFor(() => expect(resolveOldRead).toBeTypeOf('function'));
    control.handle = { name: 'db-two' };

    await act(async () => resolveOldRead?.([{ climbUuid: 'same-climb', angle: 40, playCount: 28 }]));
    expect(result.current.has(key)).toBe(false);
  });
});
