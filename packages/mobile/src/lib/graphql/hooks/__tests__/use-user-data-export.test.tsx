// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardName, UserDataExportStatus } from '@boardsesh/shared-schema';
import { UserDataExportActionError, type UserDataExportDownloadRequest } from '../../../user-data-export-action';
import {
  GET_USER_DATA_EXPORT,
  GET_USER_DATA_EXPORT_DOWNLOAD,
  REQUEST_USER_DATA_EXPORT,
} from '@boardsesh/graphql/operations/user-data-export';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  openDownload: vi.fn(),
  focused: true,
  offline: false,
  backgrounded: false,
  generation: 1,
}));
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('expo-router', () => ({ useIsFocused: () => mocks.focused }));
vi.mock('../../../../hooks/use-is-offline', () => ({ useIsOffline: () => mocks.offline }));
vi.mock('../../../app-visibility', () => ({ useIsAppBackgrounded: () => mocks.backgrounded }));
vi.mock('../../../auth-store', () => ({
  captureAuthCredentialGeneration: () => mocks.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === mocks.generation,
}));
vi.mock('../../../user-data-export-download', () => ({ openUserDataExportDownload: mocks.openDownload }));

import {
  USER_DATA_EXPORT_POLL_LIMIT_MS,
  USER_DATA_EXPORT_POLL_MS,
  useUserDataExport,
  userDataExportQueryKey,
} from '../use-user-data-export';

const clients: QueryClient[] = [];
function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(queryClient);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

function exportStatus(overrides: Partial<UserDataExportStatus> = {}): UserDataExportStatus {
  return {
    boardType: 'tension',
    period: '2026-W40',
    status: 'not_requested',
    files: [],
    refreshAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.request.mockReset().mockResolvedValue({ userDataExport: exportStatus() });
  mocks.openDownload.mockReset().mockResolvedValue(undefined);
  mocks.focused = true;
  mocks.offline = false;
  mocks.backgrounded = false;
  mocks.generation = 1;
  onlineManager.setOnline(true);
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe('user data export metadata', () => {
  it('loads only the selected board and never generates on opening the screen', async () => {
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    expect(mocks.request.mock.calls).toEqual([[GET_USER_DATA_EXPORT, { boardType: 'tension' }]]);
    expect(queryClient.getQueryData(userDataExportQueryKey('climber-a', 1, 'tension'))).toEqual(exportStatus());
  });

  it.each(['focused', 'backgrounded', 'offline'] as const)(
    'makes no request while visibility gate %s blocks it',
    async (gate) => {
      if (gate === 'focused') mocks.focused = false;
      else mocks[gate] = true;
      const { wrapper } = makeWrapper();
      const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.statusQuery.fetchStatus).toBe('idle');
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it('rejects an action while offline instead of queuing an export for reconnection', async () => {
    mocks.offline = true;
    onlineManager.setOnline(false);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await act(async () => {
      await expect(result.current.requestMutation.mutateAsync()).rejects.toMatchObject({ reason: 'offline' });
    });
    onlineManager.setOnline(true);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('drops a previous account response after the session changes', async () => {
    let finishOld: ((response: { userDataExport: UserDataExportStatus }) => void) | undefined;
    mocks.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const { queryClient, wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ userId }) => useUserDataExport(userId, 'tension'), {
      wrapper,
      initialProps: { userId: 'climber-a' },
    });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    mocks.generation = 2;
    mocks.request.mockResolvedValue({ userDataExport: exportStatus({ status: 'ready' }) });
    rerender({ userId: 'climber-b' });
    await waitFor(() => expect(result.current.statusQuery.data?.status).toBe('ready'));
    await act(async () => {
      finishOld?.({ userDataExport: exportStatus({ status: 'failed' }) });
    });
    expect(result.current.statusQuery.data?.status).toBe('ready');
    expect(queryClient.getQueryData(userDataExportQueryKey('climber-a', 1, 'tension'))).toBeUndefined();
  });

  it('does not replace the selected board with an old generation result', async () => {
    let finishRequest: ((response: { requestUserDataExport: UserDataExportStatus }) => void) | undefined;
    mocks.request.mockImplementation((document: string, variables: { boardType: BoardName }) =>
      document === REQUEST_USER_DATA_EXPORT
        ? new Promise((resolve) => {
            finishRequest = resolve;
          })
        : Promise.resolve({ userDataExport: exportStatus({ boardType: variables.boardType }) }),
    );
    const { queryClient, wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ boardType }) => useUserDataExport('climber-a', boardType), {
      wrapper,
      initialProps: { boardType: 'tension' as BoardName },
    });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let requesting: Promise<UserDataExportStatus> | undefined;
    await act(async () => {
      requesting = result.current.requestMutation.mutateAsync();
    });
    await waitFor(() => expect(finishRequest).toBeTypeOf('function'));
    rerender({ boardType: 'moonboard' });
    await waitFor(() => expect(result.current.statusQuery.data?.boardType).toBe('moonboard'));
    await act(async () => {
      finishRequest?.({ requestUserDataExport: exportStatus({ status: 'generating' }) });
      await requesting;
    });
    expect(result.current.statusQuery.data?.boardType).toBe('moonboard');
    expect(
      queryClient.getQueryData<UserDataExportStatus>(userDataExportQueryKey('climber-a', 1, 'tension'))?.status,
    ).toBe('not_requested');
  });
});

describe('bounded export polling', () => {
  it('keeps a Sunday request pinned after Monday, then refreshes a completed file into the new week', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T23:59:59.000Z'));
    const sundayStatus = exportStatus({ period: '2026-W40', refreshAt: '2026-10-05T00:00:00.000Z' });
    mocks.request.mockImplementation((document: string, variables: { period?: string }) => {
      if (document === REQUEST_USER_DATA_EXPORT) {
        return Promise.resolve({ requestUserDataExport: { ...sundayStatus, status: 'generating' } });
      }
      if (variables.period === '2026-W40') {
        return Promise.resolve({ userDataExport: { ...sundayStatus, status: 'ready' } });
      }
      return Promise.resolve({
        userDataExport:
          Date.now() < Date.parse(sundayStatus.refreshAt) ? sundayStatus : exportStatus({ period: '2026-W41' }),
      });
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      await result.current.requestMutation.mutateAsync();
    });
    expect(result.current.statusQuery.data?.status).toBe('generating');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USER_DATA_EXPORT_POLL_MS);
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.request).toHaveBeenCalledWith(GET_USER_DATA_EXPORT, { boardType: 'tension', period: '2026-W40' });
    expect(result.current.statusQuery.data?.period).toBe('2026-W40');
    expect(result.current.statusQuery.data?.status).toBe('ready');
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.statusQuery.data?.period).toBe('2026-W41');
    expect(result.current.statusQuery.data?.status).toBe('not_requested');
  });

  it('polls every five seconds, stops after five minutes, and allows manual refresh', async () => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValue({ userDataExport: exportStatus({ status: 'generating' }) });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.statusQuery.data?.status).toBe('generating');
    const initialCount = mocks.request.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USER_DATA_EXPORT_POLL_MS);
    });
    expect(mocks.request).toHaveBeenCalledTimes(initialCount + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USER_DATA_EXPORT_POLL_LIMIT_MS);
    });
    expect(result.current.pollLimitReached).toBe(true);
    const finalCount = mocks.request.mock.calls.length;
    expect(finalCount).toBeLessThanOrEqual(61);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.request).toHaveBeenCalledTimes(finalCount);
    await act(async () => {
      await result.current.refresh();
    });
    expect(mocks.request).toHaveBeenCalledTimes(finalCount + 1);
    expect(result.current.pollLimitReached).toBe(true);
  });

  it('stops polling offscreen and does not restart its five-minute budget on refocus', async () => {
    vi.useFakeTimers();
    mocks.request.mockResolvedValue({ userDataExport: exportStatus({ status: 'generating' }) });
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    mocks.focused = false;
    rerender();
    const initialCount = mocks.request.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(USER_DATA_EXPORT_POLL_LIMIT_MS);
    });
    expect(mocks.request).toHaveBeenCalledTimes(initialCount);
    mocks.focused = true;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.pollLimitReached).toBe(true);
    expect(mocks.request).toHaveBeenCalledTimes(initialCount);
  });
});

describe('fresh private export downloads', () => {
  it('gets a new signed URL for each tap and never caches those URLs', async () => {
    mocks.request.mockImplementation((document: string) => {
      if (document === GET_USER_DATA_EXPORT_DOWNLOAD) {
        const downloads = mocks.request.mock.calls.filter(
          ([operation]) => operation === GET_USER_DATA_EXPORT_DOWNLOAD,
        ).length;
        return Promise.resolve({
          userDataExportDownload: {
            url: `https://private.test/export?signature=${downloads}`,
            expiresAt: '2026-09-29T12:05:00Z',
            filename: 'tension.json',
          },
        });
      }
      return Promise.resolve({ userDataExport: exportStatus({ status: 'ready' }) });
    });
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    for (let tap = 0; tap < 2; tap++) {
      await act(async () => {
        await result.current.downloadMutation.mutateAsync({ period: '2026-W40', format: 'boardsesh' });
      });
    }
    expect(mocks.openDownload.mock.calls).toEqual([
      [
        expect.objectContaining({
          url: 'https://private.test/export?signature=1',
          filename: 'tension.json',
          credentialGeneration: 1,
        }),
      ],
      [
        expect.objectContaining({
          url: 'https://private.test/export?signature=2',
          filename: 'tension.json',
          credentialGeneration: 1,
        }),
      ],
    ]);
    expect(mocks.request).toHaveBeenCalledWith(GET_USER_DATA_EXPORT_DOWNLOAD, {
      boardType: 'tension',
      period: '2026-W40',
      format: 'boardsesh',
    });
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain('signature');
    expect(
      queryClient
        .getMutationCache()
        .getAll()
        .every((mutation) => mutation.state.data === undefined),
    ).toBe(true);
  });

  it('does not open an old account file when the session changes during link retrieval', async () => {
    let finishDownload: ((response: unknown) => void) | undefined;
    mocks.request.mockImplementation((document: string) =>
      document === GET_USER_DATA_EXPORT_DOWNLOAD
        ? new Promise((resolve) => {
            finishDownload = resolve;
          })
        : Promise.resolve({ userDataExport: exportStatus() }),
    );
    const { wrapper } = makeWrapper();
    const { result, rerender } = renderHook(({ userId }) => useUserDataExport(userId, 'tension'), {
      wrapper,
      initialProps: { userId: 'climber-a' },
    });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let downloadOutcome: Promise<unknown> | undefined;
    await act(async () => {
      downloadOutcome = result.current.downloadMutation
        .mutateAsync({ period: '2026-W40', format: 'boardsesh' })
        .catch((error: unknown) => error);
    });
    await waitFor(() => expect(finishDownload).toBeTypeOf('function'));
    mocks.generation = 2;
    rerender({ userId: 'climber-b' });
    await act(async () => {
      finishDownload?.({ userDataExportDownload: { url: 'https://private.test/old-user.json' } });
    });
    expect(await downloadOutcome).toMatchObject({ reason: 'session_changed' });
    expect(mocks.openDownload).not.toHaveBeenCalled();
  });

  it('surfaces browser failures so a new-link retry is available', async () => {
    mocks.request
      .mockResolvedValueOnce({ userDataExport: exportStatus() })
      .mockResolvedValueOnce({ userDataExportDownload: { url: 'https://private.test/export.json' } });
    mocks.openDownload.mockRejectedValue(new UserDataExportActionError('browser_failed'));
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    await act(async () => {
      await expect(
        result.current.downloadMutation.mutateAsync({ period: '2026-W40', format: 'boardsesh' }),
      ).rejects.toMatchObject({ reason: 'browser_failed' });
    });
  });

  it('stays pending through native sharing and never stores the private helper input', async () => {
    let finishSharing: (() => void) | undefined;
    mocks.openDownload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSharing = resolve;
        }),
    );
    mocks.request.mockImplementation((document: string) =>
      Promise.resolve(
        document === GET_USER_DATA_EXPORT_DOWNLOAD
          ? {
              userDataExportDownload: {
                url: 'https://private.test/export?signature=private',
                filename: 'tension.json',
              },
            }
          : { userDataExport: exportStatus() },
      ),
    );
    const { queryClient, wrapper } = makeWrapper();
    const { result } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let outcome: Promise<void> | undefined;
    await act(async () => {
      outcome = result.current.downloadMutation.mutateAsync({ period: '2026-W40', format: 'aurora' });
    });
    await waitFor(() => expect(result.current.downloadMutation.isPending).toBe(true));
    expect(mocks.openDownload).toHaveBeenCalled();
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state),
      ),
    ).not.toContain('signature');
    await act(async () => {
      finishSharing?.();
      await outcome;
    });
    await waitFor(() => expect(result.current.downloadMutation.isPending).toBe(false));
  });

  it('aborts native work and invalidates its ownership guard when unmounted', async () => {
    let downloadRequest: UserDataExportDownloadRequest | undefined;
    mocks.openDownload.mockImplementation((request: UserDataExportDownloadRequest) => {
      downloadRequest = request;
      return new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(new UserDataExportActionError('session_changed')), {
          once: true,
        }),
      );
    });
    mocks.request.mockImplementation((document: string) =>
      Promise.resolve(
        document === GET_USER_DATA_EXPORT_DOWNLOAD
          ? { userDataExportDownload: { url: 'https://private.test/export.json', filename: 'tension.json' } }
          : { userDataExport: exportStatus() },
      ),
    );
    const { wrapper } = makeWrapper();
    const { result, unmount } = renderHook(() => useUserDataExport('climber-a', 'tension'), { wrapper });
    await waitFor(() => expect(result.current.statusQuery.isSuccess).toBe(true));
    let outcome: Promise<unknown> | undefined;
    await act(async () => {
      outcome = result.current.downloadMutation
        .mutateAsync({ period: '2026-W40', format: 'boardsesh' })
        .catch((error: unknown) => error);
    });
    await waitFor(() => expect(downloadRequest).toBeDefined());
    expect(downloadRequest?.isCurrent()).toBe(true);
    unmount();
    expect(downloadRequest?.signal.aborted).toBe(true);
    expect(downloadRequest?.isCurrent()).toBe(false);
    expect(await outcome).toMatchObject({ reason: 'session_changed' });
  });
});
