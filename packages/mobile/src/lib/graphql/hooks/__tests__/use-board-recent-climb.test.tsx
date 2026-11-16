// @vitest-environment jsdom
//
// The board switcher's thumbnails read `boardRecentClimbs`. The numeric id is
// the no-link reading, so an Unlisted wall's thumbnail only lights up when the
// board's own uuid rides along (#6392). A hidden board found by serial has an
// empty uuid, which is no link at all and must never be sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BOARD_RECENT_CLIMBS } from '@boardsesh/graphql/operations/board-presence';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('../../client', () => ({ getHttpClient: () => ({ request: requestMock }) }));

import { useBoardRecentClimb } from '../use-board-recent-climb';

const BOARD_UUID = '11111111-1111-4111-8111-111111111111';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useBoardRecentClimb', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockResolvedValue({ boardRecentClimbs: [] });
  });

  it("sends the board's uuid with its numeric id", async () => {
    renderHook(() => useBoardRecentClimb(7, BOARD_UUID), { wrapper: makeWrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock).toHaveBeenCalledWith(BOARD_RECENT_CLIMBS, { boardId: 7, boardUuid: BOARD_UUID });
  });

  it.each([
    ['an empty', ''],
    ['no', null],
  ])('sends the numeric id alone for %s uuid', async (_label, boardUuid) => {
    renderHook(() => useBoardRecentClimb(7, boardUuid), { wrapper: makeWrapper() });

    await waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    expect(requestMock).toHaveBeenCalledWith(BOARD_RECENT_CLIMBS, { boardId: 7 });
  });

  it('does not ask about a board with no numeric id', async () => {
    renderHook(() => useBoardRecentClimb(null, BOARD_UUID), { wrapper: makeWrapper() });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestMock).not.toHaveBeenCalled();
  });
});
