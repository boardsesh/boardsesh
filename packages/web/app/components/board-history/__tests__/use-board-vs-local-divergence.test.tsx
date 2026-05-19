import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook } from '@testing-library/react';
import type { BoardHistoryEntry } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';

/**
 * Mocks for the underlying hooks. The divergence hook itself is pure
 * (no async, no providers), so we can drive it by swapping the values
 * returned from the two collaborator hooks.
 */
let mockLatestEntry: BoardHistoryEntry | null = null;
let mockCurrentClimbQueueItem: ClimbQueueItem | null = null;

vi.mock('../use-board-history', () => ({
  useBoardHistory: () => ({
    history: mockLatestEntry ? [mockLatestEntry] : [],
    latestEntry: mockLatestEntry,
    boardSerial: 'serial-A',
    isLoading: false,
    isSubscribed: true,
  }),
}));

vi.mock('@/app/components/graphql-queue', () => ({
  useCurrentClimb: () => ({
    currentClimbQueueItem: mockCurrentClimbQueueItem,
    currentClimb: mockCurrentClimbQueueItem?.climb ?? null,
  }),
}));

import { useBoardVsLocalDivergence } from '../use-board-vs-local-divergence';

function makeEntry(overrides: Partial<BoardHistoryEntry> = {}): BoardHistoryEntry {
  return {
    id: 'row-1',
    uuid: 'send-uuid-1',
    boardSerial: 'serial-A',
    boardId: null,
    climbUuid: 'climb-A',
    angle: 40,
    isMirror: false,
    source: 'BLE_SEND',
    userId: 'user-1',
    username: 'Marco',
    sessionId: null,
    sentAt: new Date().toISOString(),
    sequence: 1,
    ...overrides,
  };
}

function makeQueueItem(climbUuid: string, angle: number): ClimbQueueItem {
  return {
    uuid: 'queue-item-1',
    addedBy: 'user-1',
    suggested: false,
    climb: {
      uuid: climbUuid,
      setter_username: 'setter',
      name: 'Some Climb',
      description: '',
      frames: '',
      angle,
      ascensionist_count: 0,
      difficulty: 'V4',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0.00',
      mirrored: false,
      benchmark_difficulty: null,
    },
  };
}

describe('useBoardVsLocalDivergence', () => {
  beforeEach(() => {
    mockLatestEntry = null;
    mockCurrentClimbQueueItem = null;
  });

  it('returns divergent=false when both sides are null', () => {
    mockLatestEntry = null;
    mockCurrentClimbQueueItem = null;
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(false);
    expect(result.current.boardCurrent).toBeNull();
    expect(result.current.localPick).toBeNull();
  });

  it('returns divergent=false when only board is null', () => {
    mockLatestEntry = null;
    mockCurrentClimbQueueItem = makeQueueItem('climb-A', 40);
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(false);
  });

  it('returns divergent=false when only local is null', () => {
    mockLatestEntry = makeEntry();
    mockCurrentClimbQueueItem = null;
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(false);
  });

  it('returns divergent=false when climbUuid and angle both match', () => {
    mockLatestEntry = makeEntry({ climbUuid: 'climb-A', angle: 40 });
    mockCurrentClimbQueueItem = makeQueueItem('climb-A', 40);
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(false);
  });

  it('returns divergent=true when climbUuid differs', () => {
    mockLatestEntry = makeEntry({ climbUuid: 'climb-A', angle: 40 });
    mockCurrentClimbQueueItem = makeQueueItem('climb-B', 40);
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(true);
  });

  it('returns divergent=true when angle differs', () => {
    mockLatestEntry = makeEntry({ climbUuid: 'climb-A', angle: 40 });
    mockCurrentClimbQueueItem = makeQueueItem('climb-A', 30);
    const { result } = renderHook(() => useBoardVsLocalDivergence());
    expect(result.current.divergent).toBe(true);
  });
});
