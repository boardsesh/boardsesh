// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, act } from '@testing-library/react';
import { createBoardAdapterWrapper, createTestQueryClient } from '@/app/test-utils/test-providers';
import type { ExecuteHttp } from '@boardsesh/board-react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSession } from 'next-auth/react';
import { useLogbook, accumulatedLogbookQueryKey, type LogbookEntry } from '@boardsesh/board-react';
import type { BoardName } from '@/app/lib/types';
import { AscentStatus } from '../ascent-status';

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: vi.fn(),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

vi.mock('@boardsesh/graphql/operations', () => ({
  GET_TICKS: 'GET_TICKS_QUERY',
}));

const mockUseWsAuthToken = vi.mocked(useWsAuthToken);
const mockUseSession = vi.mocked(useSession);

/**
 * The badge takes its ticks as a prop (W-12) rather than reading
 * `useOptionalBoardProvider`, so the front door can render it for an anonymous
 * visitor with no provider anywhere in the tree. Every case here therefore
 * passes the logbook directly — no BoardContext is mounted at all.
 */
function renderWithLogbook({
  boardName = 'kilter',
  logbook = [],
  angle = 40,
}: {
  boardName?: BoardName;
  logbook?: LogbookEntry[];
  angle?: number;
} = {}) {
  return render(<AscentStatus climbUuid="climb-1" angle={angle} logbook={logbook} boardName={boardName} />);
}

function AscentStatusHarness({ angle = 40 }: { angle?: number } = {}) {
  const { logbook } = useLogbook('kilter', ['climb-1']);

  return <AscentStatus climbUuid="climb-1" angle={angle} logbook={logbook} boardName="kilter" />;
}

describe('AscentStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    mockUseWsAuthToken.mockReturnValue({
      token: 'test-token',
      isAuthenticated: true,
      isLoading: false,
      error: null,
    });
    mockUseSession.mockReturnValue({
      status: 'authenticated',
      data: { user: { id: '1' }, expires: '' },
      update: vi.fn(),
    });
  });

  it('renders nothing when the climb has no logbook entries', () => {
    const { container } = render(<AscentStatus climbUuid="climb-1" angle={40} logbook={[]} />);
    expect(container.innerHTML).toBe('');
  });

  // The anonymous/crawler path: the front door renders climb rows with no
  // signed-in viewer and no BoardProvider anywhere in the tree.
  it('renders nothing with no logbook prop and no board provider mounted', () => {
    const { container } = render(<AscentStatus climbUuid="climb-1" angle={40} />);
    expect(container.innerHTML).toBe('');
  });

  it('hides the badge when the only ticks are at a different angle than the current view', () => {
    renderWithLogbook({
      boardName: 'kilter',
      logbook: [
        {
          uuid: '1',
          climb_uuid: 'climb-1',
          angle: 30,
          is_mirror: false,
          tries: 1,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-01T00:00:00.000Z',
          is_ascent: true,
          status: 'send',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ],
      angle: 50,
    });

    expect(screen.queryByTestId('ascent-badge')).toBeNull();
  });

  it('shows the badge only for ticks at the current angle', () => {
    renderWithLogbook({
      boardName: 'kilter',
      logbook: [
        {
          uuid: '1',
          climb_uuid: 'climb-1',
          angle: 30,
          is_mirror: false,
          tries: 1,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-01T00:00:00.000Z',
          is_ascent: true,
          status: 'flash',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: '2',
          climb_uuid: 'climb-1',
          angle: 50,
          is_mirror: false,
          tries: 4,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-02T00:00:00.000Z',
          is_ascent: false,
          status: 'attempt',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ],
      angle: 50,
    });

    expect(screen.getByTestId('ascent-badge').getAttribute('data-status')).toBe('attempt');
  });

  it('prefers flash over send and attempt for the same climb', () => {
    renderWithLogbook({
      boardName: 'kilter',
      logbook: [
        {
          uuid: '1',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 3,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-01T00:00:00.000Z',
          is_ascent: true,
          status: 'send',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: '2',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 1,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-02T00:00:00.000Z',
          is_ascent: true,
          status: 'flash',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: '3',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 2,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-03T00:00:00.000Z',
          is_ascent: false,
          status: 'attempt',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ],
    });

    expect(screen.getByTestId('ascent-badge').getAttribute('data-status')).toBe('flash');
  });

  it('renders separate mirrored and regular statuses on mirroring boards', () => {
    renderWithLogbook({
      boardName: 'tension',
      logbook: [
        {
          uuid: '1',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 2,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-01T00:00:00.000Z',
          is_ascent: true,
          status: 'send',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: '2',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: true,
          tries: 1,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-02T00:00:00.000Z',
          is_ascent: true,
          status: 'flash',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ],
    });

    expect(screen.getByTestId('ascent-badge').getAttribute('data-status')).toBe('send');
    expect(screen.getByTestId('ascent-badge-mirrored').getAttribute('data-status')).toBe('flash');
  });

  it('renders separate mirrored and regular statuses on Woods, same as Tension', () => {
    renderWithLogbook({
      boardName: 'woods',
      logbook: [
        {
          uuid: '1',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: false,
          tries: 2,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-01T00:00:00.000Z',
          is_ascent: true,
          status: 'send',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
        {
          uuid: '2',
          climb_uuid: 'climb-1',
          angle: 40,
          is_mirror: true,
          tries: 1,
          quality: null,
          difficulty: null,
          comment: '',
          climbed_at: '2025-01-02T00:00:00.000Z',
          is_ascent: true,
          status: 'flash',
          upvotes: 0,
          downvotes: 0,
          commentCount: 0,
        },
      ],
    });

    expect(screen.getByTestId('ascent-badge').getAttribute('data-status')).toBe('send');
    expect(screen.getByTestId('ascent-badge-mirrored').getAttribute('data-status')).toBe('flash');
  });

  it('renders the badge immediately from accumulated logbook cache updates without a refetch', async () => {
    mockRequest.mockResolvedValue({ ticks: [] });

    const queryClient = createTestQueryClient();
    const Wrapper = createBoardAdapterWrapper(
      () => ({
        isAuthenticated: mockUseSession().status === 'authenticated',
        isAuthLoading: mockUseSession().status === 'loading',
        executeHttp: (async (query: string, variables?: object) =>
          mockRequest(query, variables)) as unknown as ExecuteHttp,
      }),
      { queryClient },
    );
    render(
      <Wrapper>
        <AscentStatusHarness />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('ascent-badge')).toBeNull();

    const optimisticEntry: LogbookEntry = {
      uuid: 'temp-1',
      climb_uuid: 'climb-1',
      angle: 40,
      is_mirror: false,
      tries: 1,
      quality: null,
      difficulty: null,
      comment: '',
      climbed_at: '2024-02-01',
      is_ascent: true,
      status: 'flash',
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    };

    act(() => {
      queryClient.setQueryData<LogbookEntry[]>(accumulatedLogbookQueryKey('kilter'), [optimisticEntry]);
    });

    await waitFor(() => {
      expect(screen.getByTestId('ascent-badge')).not.toBeNull();
    });
    expect(screen.getByTestId('ascent-badge').getAttribute('data-status')).toBe('flash');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});
