// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PIN_BOARD, UNPIN_BOARD } from '@boardsesh/graphql/operations/boards';

// Two fast taps on one card fire pin and then unpin as two independent requests.
// Nothing in HTTP promises they reach the server in that order, and the loser is
// the server: it can settle on "pinned" while the card's local override says
// otherwise, and the disagreement survives until the picker is next opened. The
// mutation runs in a scope so the second toggle waits for the first to settle,
// which is what these tests hold — the ordering, not the option that buys it.

const requestMock = vi.fn();
vi.mock('../../client', () => ({
  getHttpClient: () => ({ request: requestMock }),
}));

// The hooks barrel re-exports siblings that transitively pull in react-native /
// expo-router. usePinBoard is pure React Query and touches none of them, so stub
// the heavy re-exports so the barrel parses under the node SSR transform.
vi.mock('react-native', () => ({}));
vi.mock('../use-infinite-search-climbs', () => ({ useInfiniteSearchClimbs: vi.fn() }));
vi.mock('../use-beta-link-preview', () => ({ useBetaLinkPreview: vi.fn() }));
vi.mock('../use-mobile-climb-actions-data', () => ({ useMobileClimbActionsData: vi.fn() }));
vi.mock('../use-you-data', () => ({
  useAllBoardsTicks: vi.fn(),
  useUserProfileStats: vi.fn(),
  useUserClimbPercentile: vi.fn(),
  useUserAscentsFeed: vi.fn(),
  useSessionGroupedFeed: vi.fn(),
}));
vi.mock('../use-you-profile-data', () => ({ useYouProfileData: vi.fn() }));
vi.mock('../use-social', () => ({
  useVote: vi.fn(),
  useBulkVoteSummaries: vi.fn(),
  useComments: vi.fn(),
  useAddComment: vi.fn(),
}));
vi.mock('../use-session-detail', () => ({ useSessionDetail: vi.fn(), useSessionPreview: vi.fn() }));
vi.mock('../use-integrations', () => ({
  useIntegrationStatuses: vi.fn(),
  useDisconnectIntegration: vi.fn(),
  useSetIntegrationAutoSync: vi.fn(),
  useSyncSessionToIntegration: vi.fn(),
}));

import { usePinBoard } from '../index';

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

/** A request mock whose responses are released by hand, one at a time. */
function deferredRequests() {
  const releases: Array<() => void> = [];
  requestMock.mockImplementation(
    (document: string) =>
      new Promise((resolve) => {
        releases.push(() => resolve(document === PIN_BOARD ? { pinBoard: true } : { unpinBoard: true }));
      }),
  );
  return releases;
}

/** Which mutation document each call sent, in the order the client saw them. */
function sentDocuments(): string[] {
  return requestMock.mock.calls.map((call) => (call[0] === PIN_BOARD ? 'PIN' : 'UNPIN'));
}

describe('usePinBoard', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it('holds the second toggle until the first settles', async () => {
    const releases = deferredRequests();
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePinBoard(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ boardUuid: 'board-1', pinned: true });
      result.current.mutate({ boardUuid: 'board-1', pinned: false });
    });

    // The unpin has NOT reached the client: it is queued behind the pin, so the
    // server can never see the pair inverted.
    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(sentDocuments()).toEqual(['PIN']);

    act(() => releases[0]());

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(2));
    expect(sentDocuments()).toEqual(['PIN', 'UNPIN']);
  });

  it('sends both toggles, in the order the climber tapped them', async () => {
    const releases = deferredRequests();
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePinBoard(), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ boardUuid: 'board-1', pinned: true });
      result.current.mutate({ boardUuid: 'board-1', pinned: false });
    });

    await waitFor(() => expect(releases).toHaveLength(1));
    act(() => releases[0]());
    await waitFor(() => expect(releases).toHaveLength(2));
    act(() => releases[1]());

    // Serializing must not swallow a tap: an `isPending` guard in the handler
    // would leave the board pinned when the climber asked for unpinned.
    await waitFor(() => expect(sentDocuments()).toEqual(['PIN', 'UNPIN']));
    expect(requestMock.mock.calls[1][1]).toEqual({ input: { boardUuid: 'board-1' } });
    expect(requestMock.mock.calls[1][0]).toBe(UNPIN_BOARD);
  });

  it('reports the failing board to onPinError so the glyph can go back', async () => {
    requestMock.mockRejectedValue(new Error('offline'));
    const onPinError = vi.fn();
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePinBoard({ onPinError }), { wrapper: Wrapper });

    act(() => {
      result.current.mutate({ boardUuid: 'board-9', pinned: true });
    });

    await waitFor(() => expect(onPinError).toHaveBeenCalledTimes(1));
    expect(onPinError.mock.calls[0][0]).toBe('board-9');
  });
});
