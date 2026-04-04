import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQueueStorageSync } from '../use-queue-storage-sync';
import type { ClimbQueueItem } from '../../../queue-control/types';
import type { Climb, BoardDetails } from '@/app/lib/types';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

const mockQueueItem: ClimbQueueItem = {
  uuid: 'item-1',
  climb: mockClimb,
  addedBy: 'user-1',
  suggested: false,
};

const mockBoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: '1',
  images_to_holds: {},
} as unknown as BoardDetails;

describe('useQueueStorageSync', () => {
  const mockSetLocalQueueState = vi.fn();

  beforeEach(() => {
    mockSetLocalQueueState.mockClear();
  });

  it('does not sync until restoration is complete', () => {
    renderHook(() =>
      useQueueStorageSync({
        hasRestored: false,
        isPersistentSessionActive: false,
        sessionId: null,
        queue: [mockQueueItem],
        currentClimbQueueItem: null,
        baseBoardPath: '/kilter/1/1/1',
        boardDetails: mockBoardDetails,
        isDisconnected: false,
        persistentSession: { setLocalQueueState: mockSetLocalQueueState },
      }),
    );

    expect(mockSetLocalQueueState).not.toHaveBeenCalled();
  });

  it('syncs in solo mode (no session)', () => {
    renderHook(() =>
      useQueueStorageSync({
        hasRestored: true,
        isPersistentSessionActive: false,
        sessionId: null,
        queue: [mockQueueItem],
        currentClimbQueueItem: null,
        baseBoardPath: '/kilter/1/1/1',
        boardDetails: mockBoardDetails,
        isDisconnected: false,
        persistentSession: { setLocalQueueState: mockSetLocalQueueState },
      }),
    );

    expect(mockSetLocalQueueState).toHaveBeenCalledWith(
      [mockQueueItem],
      null,
      '/kilter/1/1/1',
      mockBoardDetails,
    );
  });

  it('does NOT sync when party mode is active and online', () => {
    renderHook(() =>
      useQueueStorageSync({
        hasRestored: true,
        isPersistentSessionActive: true,
        sessionId: 'session-1',
        queue: [mockQueueItem],
        currentClimbQueueItem: null,
        baseBoardPath: '/kilter/1/1/1',
        boardDetails: mockBoardDetails,
        isDisconnected: false,
        persistentSession: { setLocalQueueState: mockSetLocalQueueState },
      }),
    );

    expect(mockSetLocalQueueState).not.toHaveBeenCalled();
  });

  it('DOES sync when party mode is active but offline', () => {
    renderHook(() =>
      useQueueStorageSync({
        hasRestored: true,
        isPersistentSessionActive: true,
        sessionId: 'session-1',
        queue: [mockQueueItem],
        currentClimbQueueItem: null,
        baseBoardPath: '/kilter/1/1/1',
        boardDetails: mockBoardDetails,
        isDisconnected: true,
        persistentSession: { setLocalQueueState: mockSetLocalQueueState },
      }),
    );

    expect(mockSetLocalQueueState).toHaveBeenCalledWith(
      [mockQueueItem],
      null,
      '/kilter/1/1/1',
      mockBoardDetails,
    );
  });

  it('stops syncing when transitioning from offline to online in party mode', () => {
    const { rerender } = renderHook(
      (props) => useQueueStorageSync(props),
      {
        initialProps: {
          hasRestored: true,
          isPersistentSessionActive: true,
          sessionId: 'session-1' as string | null,
          queue: [mockQueueItem],
          currentClimbQueueItem: null as ClimbQueueItem | null,
          baseBoardPath: '/kilter/1/1/1',
          boardDetails: mockBoardDetails,
          isDisconnected: true,
          persistentSession: { setLocalQueueState: mockSetLocalQueueState },
        },
      },
    );

    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    mockSetLocalQueueState.mockClear();

    rerender({
      hasRestored: true,
      isPersistentSessionActive: true,
      sessionId: 'session-1',
      queue: [mockQueueItem],
      currentClimbQueueItem: null,
      baseBoardPath: '/kilter/1/1/1',
      boardDetails: mockBoardDetails,
      isDisconnected: false,
      persistentSession: { setLocalQueueState: mockSetLocalQueueState },
    });

    expect(mockSetLocalQueueState).not.toHaveBeenCalled();
  });
});
