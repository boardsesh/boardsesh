// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

const mocks = vi.hoisted(() => ({
  database: { name: 'offline-db' },
  deadLetterCount: vi.fn(),
  deadLetters: vi.fn(),
  retryDeadLetter: vi.fn(),
  drain: vi.fn(),
  notifyOutboxChanged: vi.fn(),
  reportError: vi.fn(),
  haptic: vi.fn(),
  effectiveOffline: false,
}));

vi.mock('@boardsesh/offline-sync', () => ({
  getDeadLetterCount: mocks.deadLetterCount,
  getDeadLetters: mocks.deadLetters,
  retryDeadLetter: mocks.retryDeadLetter,
}));
vi.mock('../../../../db/use-offline-database', () => ({ useOfflineDatabase: () => mocks.database }));
vi.mock('../../../../db/use-offline-schema-ready', () => ({ useOfflineSchemaReady: () => true }));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: mocks.effectiveOffline }),
}));
vi.mock('../../../../lib/error-reporting', () => ({ reportError: mocks.reportError }));
vi.mock('../../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../../lib/haptics', () => ({ hapticLight: mocks.haptic }));
vi.mock('../../../../offline/offline-sync-adapter', () => ({ drainMutationQueue: mocks.drain }));
vi.mock('../../../../offline/outbox-store', () => ({ notifyOutboxChanged: mocks.notifyOutboxChanged }));
vi.mock('../../../../providers/feature-flags-provider', () => ({ useOfflineDownloadsEnabled: () => true }));

const { useSyncIssues, useSyncIssuesSection } = await import('../use-sync-issues');

let queryClient: QueryClient;

function wrapper({ children }: { children?: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

/** Render the hook and wait for the first dead-letter count to land. */
async function renderWithIssues(count = 2) {
  mocks.deadLetterCount.mockResolvedValue(count);
  const rendered = renderHook(() => useSyncIssues(), { wrapper });
  await waitFor(() => expect(rendered.result.current).not.toBeNull());
  return rendered;
}

/** A promise the test settles by hand, to hold a retry mid-flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.effectiveOffline = false;
  mocks.deadLetterCount.mockReset().mockResolvedValue(0);
  mocks.deadLetters.mockReset().mockResolvedValue([]);
  mocks.retryDeadLetter.mockReset().mockResolvedValue(undefined);
  mocks.drain.mockReset().mockResolvedValue(undefined);
  mocks.notifyOutboxChanged.mockReset();
  mocks.reportError.mockReset();
  mocks.haptic.mockReset();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('useSyncIssues — when it shows', () => {
  it('says nothing when no write is stuck', async () => {
    const { result } = renderHook(() => useSyncIssues(), { wrapper });
    await waitFor(() => expect(mocks.deadLetterCount).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('reports how many writes are stuck', async () => {
    const { result } = await renderWithIssues(3);
    expect(result.current?.count).toBe(3);
  });

  it('says nothing offline, where a waiting write is expected', async () => {
    mocks.effectiveOffline = true;
    mocks.deadLetterCount.mockResolvedValue(3);
    const { result } = renderHook(() => useSyncIssues(), { wrapper });
    expect(result.current).toBeNull();
    expect(mocks.deadLetterCount).not.toHaveBeenCalled();
  });
});

describe('useSyncIssues — retry', () => {
  it('resets every dead letter, drains the outbox, then tells the pending summary', async () => {
    mocks.deadLetters.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    const { result } = await renderWithIssues();
    await act(() => result.current?.retry() ?? Promise.resolve());
    expect(mocks.retryDeadLetter.mock.calls).toEqual([
      [mocks.database, 'a'],
      [mocks.database, 'b'],
    ]);
    expect(mocks.drain).toHaveBeenCalledOnce();
    expect(mocks.drain.mock.calls[0][0]).toBe(mocks.database);
    expect(mocks.notifyOutboxChanged).toHaveBeenCalledOnce();
    // The drain runs after every reset, and the summary hears about it after the drain.
    expect(mocks.retryDeadLetter.mock.invocationCallOrder[1]).toBeLessThan(mocks.drain.mock.invocationCallOrder[0]);
    expect(mocks.drain.mock.invocationCallOrder[0]).toBeLessThan(mocks.notifyOutboxChanged.mock.invocationCallOrder[0]);
  });

  it('keeps going when one dead letter fails to reset', async () => {
    const broken = new Error('row locked');
    mocks.deadLetters.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    mocks.retryDeadLetter.mockImplementation(async (_db: unknown, id: string) => {
      if (id === 'a') throw broken;
    });
    const { result } = await renderWithIssues();
    await act(() => result.current?.retry() ?? Promise.resolve());
    expect(mocks.retryDeadLetter.mock.calls.map(([, id]) => id)).toEqual(['a', 'b', 'c']);
    expect(mocks.reportError).toHaveBeenCalledWith(broken);
    expect(mocks.drain).toHaveBeenCalledOnce();
    expect(mocks.notifyOutboxChanged).toHaveBeenCalledOnce();
  });

  it('ignores a second tap while the first retry is still running', async () => {
    const pending = deferred<{ id: string }[]>();
    mocks.deadLetters.mockReturnValueOnce(pending.promise);
    const { result } = await renderWithIssues();
    const retry = result.current?.retry;
    if (!retry) throw new Error('no retry');
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = retry();
      await retry();
    });
    expect(mocks.deadLetters).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve([{ id: 'a' }]);
      await first;
    });
    expect(mocks.retryDeadLetter).toHaveBeenCalledOnce();
    expect(mocks.drain).toHaveBeenCalledOnce();
  });

  it('refetches the count after a retry, and again when the drain fails', async () => {
    const { result } = await renderWithIssues(2);
    const countReads = mocks.deadLetterCount.mock.calls.length;

    mocks.deadLetterCount.mockResolvedValue(0);
    await act(() => result.current?.retry() ?? Promise.resolve());
    await waitFor(() => expect(mocks.deadLetterCount.mock.calls.length).toBe(countReads + 1));
    await waitFor(() => expect(result.current).toBeNull());

    // A failed drain is reported, never surfaced as a crash, and the count is
    // still re-read so the alert can't keep quoting a stale number.
    const failure = new Error('network down');
    mocks.deadLetterCount.mockResolvedValue(2);
    await act(() => queryClient.invalidateQueries({ queryKey: ['deadLetters'] }));
    await waitFor(() => expect(result.current?.count).toBe(2));
    const readsBeforeFailure = mocks.deadLetterCount.mock.calls.length;
    mocks.drain.mockRejectedValueOnce(failure);
    await act(() => result.current?.retry() ?? Promise.resolve());
    expect(mocks.reportError).toHaveBeenCalledWith(failure);
    expect(mocks.notifyOutboxChanged).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.deadLetterCount.mock.calls.length).toBe(readsBeforeFailure + 1));
  });

  it('lets a later tap retry again once a failed retry has finished', async () => {
    mocks.deadLetters.mockRejectedValueOnce(new Error('db busy'));
    const { result } = await renderWithIssues();
    await act(() => result.current?.retry() ?? Promise.resolve());
    expect(mocks.drain).not.toHaveBeenCalled();
    await act(() => result.current?.retry() ?? Promise.resolve());
    expect(mocks.drain).toHaveBeenCalledOnce();
  });
});

describe('useSyncIssuesSection', () => {
  it('turns the issues into the alert input, with a haptic on Retry', async () => {
    mocks.deadLetterCount.mockResolvedValue(4);
    const { result } = renderHook(() => useSyncIssuesSection(), { wrapper });
    await waitFor(() => expect(result.current?.count).toBe(4));
    await act(async () => {
      result.current?.onRetry();
    });
    expect(mocks.haptic).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.drain).toHaveBeenCalledOnce());
  });
});
