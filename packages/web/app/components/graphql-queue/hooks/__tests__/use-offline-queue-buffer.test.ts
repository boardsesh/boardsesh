import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOfflineQueueBuffer } from '../use-offline-queue-buffer';
import type { ClimbQueueItem } from '../../../queue-control/types';
import type { Climb } from '@/app/lib/types';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: 'A test climb',
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

function createItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: { ...mockClimb, uuid: `climb-${uuid}` },
    addedBy: 'user-1',
    suggested: false,
  };
}

describe('useOfflineQueueBuffer', () => {
  it('starts with no pending additions', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());

    expect(result.current.hasPendingAdditions).toBe(false);
    expect(result.current.getBufferedAdditions()).toEqual([]);
  });

  it('bufferAddition adds an item', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());
    const item = createItem('item-1');

    act(() => {
      result.current.bufferAddition(item);
    });

    expect(result.current.hasPendingAdditions).toBe(true);
    expect(result.current.getBufferedAdditions()).toEqual([item]);
  });

  it('accumulates multiple additions in order', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());
    const item1 = createItem('item-1');
    const item2 = createItem('item-2');
    const item3 = createItem('item-3');

    act(() => {
      result.current.bufferAddition(item1);
      result.current.bufferAddition(item2);
      result.current.bufferAddition(item3);
    });

    expect(result.current.getBufferedAdditions()).toEqual([item1, item2, item3]);
  });

  it('clearBuffer empties the buffer', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());

    act(() => {
      result.current.bufferAddition(createItem('item-1'));
      result.current.bufferAddition(createItem('item-2'));
    });

    expect(result.current.hasPendingAdditions).toBe(true);

    act(() => {
      result.current.clearBuffer();
    });

    expect(result.current.hasPendingAdditions).toBe(false);
    expect(result.current.getBufferedAdditions()).toEqual([]);
  });

  it('caps buffer at 500 items', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());

    act(() => {
      for (let i = 0; i < 510; i++) {
        result.current.bufferAddition(createItem(`item-${i}`));
      }
    });

    expect(result.current.getBufferedAdditions()).toHaveLength(500);
    // Should contain the first 500 items
    expect(result.current.getBufferedAdditions()[0].uuid).toBe('item-0');
    expect(result.current.getBufferedAdditions()[499].uuid).toBe('item-499');
  });

  it('can add items again after clearing', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());

    act(() => {
      for (let i = 0; i < 500; i++) {
        result.current.bufferAddition(createItem(`item-${i}`));
      }
    });

    expect(result.current.getBufferedAdditions()).toHaveLength(500);

    act(() => {
      result.current.clearBuffer();
    });

    act(() => {
      result.current.bufferAddition(createItem('new-item'));
    });

    expect(result.current.getBufferedAdditions()).toHaveLength(1);
    expect(result.current.getBufferedAdditions()[0].uuid).toBe('new-item');
  });

  it('getBufferedAdditions returns a copy, not a reference', () => {
    const { result } = renderHook(() => useOfflineQueueBuffer());
    const item = createItem('item-1');

    act(() => {
      result.current.bufferAddition(item);
    });

    const copy1 = result.current.getBufferedAdditions();
    const copy2 = result.current.getBufferedAdditions();

    expect(copy1).toEqual(copy2);
    expect(copy1).not.toBe(copy2); // different array references
  });
});
