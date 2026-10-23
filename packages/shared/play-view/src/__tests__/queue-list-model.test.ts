import { describe, it, expect } from 'vitest';
import { buildQueueListModel, type QueueFlatRow } from '../queue-list-model';
import type { ClimbQueueItem } from '@boardsesh/queue';

function makeItem(uuid: string, climbUuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name: `Climb ${climbUuid}`,
      frames: '',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 10,
      difficulty: 'V5',
      quality_average: '3.5',
      stars: 3,
      difficulty_error: '0.5',
      benchmark_difficulty: null,
    },
  };
}

describe('buildQueueListModel', () => {
  it('returns empty model for empty queue', () => {
    const result = buildQueueListModel([], null, { showHistory: true, showFullHistory: false });
    expect(result.flatRows).toEqual([]);
    expect(result.currentItemFlatIndex).toBe(-1);
  });

  it('treats entire queue as future items when no current climb', () => {
    const queue = [makeItem('q1', 'c1'), makeItem('q2', 'c2')];
    const result = buildQueueListModel(queue, null, { showHistory: false, showFullHistory: false });

    expect(result.flatRows).toHaveLength(2);
    expect(result.flatRows[0].type).toBe('future-item');
    expect(result.flatRows[1].type).toBe('future-item');
    expect(result.currentItemFlatIndex).toBe(0);
  });

  it('splits queue into history, current, and future', () => {
    const queue = [makeItem('q1', 'c1'), makeItem('q2', 'c2'), makeItem('q3', 'c3'), makeItem('q4', 'c4')];
    const result = buildQueueListModel(queue, 'q2', { showHistory: true, showFullHistory: false });

    const types = result.flatRows.map((row) => row.type);
    expect(types).toEqual(['history-item', 'history-divider', 'current-item', 'future-item', 'future-item']);

    const currentRow = result.flatRows[result.currentItemFlatIndex] as Extract<QueueFlatRow, { type: 'current-item' }>;
    expect(currentRow.item.climb.uuid).toBe('c2');
  });

  it('hides history items beyond the limit', () => {
    const queue = Array.from({ length: 10 }, (_, i) => makeItem(`q${i}`, `c${i}`));
    const result = buildQueueListModel(queue, 'q8', {
      showHistory: true,
      showFullHistory: false,
      historyDisplayLimit: 3,
    });

    const types = result.flatRows.map((row) => row.type);
    expect(types[0]).toBe('history-show-all');
    const showAllRow = result.flatRows[0] as Extract<QueueFlatRow, { type: 'history-show-all' }>;
    expect(showAllRow.hiddenCount).toBe(5);

    const historyRows = result.flatRows.filter((row) => row.type === 'history-item');
    expect(historyRows).toHaveLength(3);
  });

  it('shows all history when showFullHistory is true', () => {
    const queue = Array.from({ length: 10 }, (_, i) => makeItem(`q${i}`, `c${i}`));
    const result = buildQueueListModel(queue, 'q8', {
      showHistory: true,
      showFullHistory: true,
      historyDisplayLimit: 3,
    });

    const hasShowAll = result.flatRows.some((row) => row.type === 'history-show-all');
    expect(hasShowAll).toBe(false);

    const historyRows = result.flatRows.filter((row) => row.type === 'history-item');
    expect(historyRows).toHaveLength(8);
  });

  it('skips history entirely when showHistory is false', () => {
    const queue = [makeItem('q1', 'c1'), makeItem('q2', 'c2'), makeItem('q3', 'c3')];
    const result = buildQueueListModel(queue, 'q2', { showHistory: false, showFullHistory: false });

    const types = result.flatRows.map((row) => row.type);
    expect(types).toEqual(['current-item', 'future-item']);
  });

  it('handles current climb at queue start', () => {
    const queue = [makeItem('q1', 'c1'), makeItem('q2', 'c2')];
    const result = buildQueueListModel(queue, 'q1', { showHistory: true, showFullHistory: false });

    const types = result.flatRows.map((row) => row.type);
    expect(types).toEqual(['current-item', 'future-item']);
    expect(result.currentItemFlatIndex).toBe(0);
  });

  it('handles current climb at queue end', () => {
    const queue = [makeItem('q1', 'c1'), makeItem('q2', 'c2')];
    const result = buildQueueListModel(queue, 'q2', { showHistory: true, showFullHistory: false });

    const types = result.flatRows.map((row) => row.type);
    expect(types).toEqual(['history-item', 'history-divider', 'current-item']);
    expect(result.currentItemFlatIndex).toBe(2);
  });

  it('preserves queueIndex for all item rows', () => {
    const queue = [makeItem('q0', 'c0'), makeItem('q1', 'c1'), makeItem('q2', 'c2'), makeItem('q3', 'c3')];
    const result = buildQueueListModel(queue, 'q1', { showHistory: true, showFullHistory: true });

    const itemRows = result.flatRows.filter(
      (row): row is Extract<QueueFlatRow, { type: 'history-item' | 'current-item' | 'future-item' }> =>
        row.type === 'history-item' || row.type === 'current-item' || row.type === 'future-item',
    );

    expect(itemRows.map((row) => row.queueIndex)).toEqual([0, 1, 2, 3]);
  });

  it('matches correct queue-item when same climb appears twice in queue', () => {
    // Same climb UUID but different queue-item UUIDs
    const queue = [makeItem('q1', 'shared-climb'), makeItem('q2', 'shared-climb'), makeItem('q3', 'c3')];
    const result = buildQueueListModel(queue, 'q2', { showHistory: true, showFullHistory: true });

    const types = result.flatRows.map((row) => row.type);
    expect(types).toEqual(['history-item', 'history-divider', 'current-item', 'future-item']);

    // The current item should be the second queue entry (q2), not the first (q1)
    const currentRow = result.flatRows[result.currentItemFlatIndex] as Extract<QueueFlatRow, { type: 'current-item' }>;
    expect(currentRow.item.uuid).toBe('q2');
    expect(currentRow.item.climb.uuid).toBe('shared-climb');

    // The first entry (q1) should be in history
    const historyRow = result.flatRows[0] as Extract<QueueFlatRow, { type: 'history-item' }>;
    expect(historyRow.item.uuid).toBe('q1');
    expect(historyRow.item.climb.uuid).toBe('shared-climb');
  });

  it('uses default history limit of 2', () => {
    const queue = Array.from({ length: 12 }, (_, i) => makeItem(`q${i}`, `c${i}`));
    const result = buildQueueListModel(queue, 'q10', { showHistory: true, showFullHistory: false });

    const showAllRow = result.flatRows.find((row) => row.type === 'history-show-all') as
      | Extract<QueueFlatRow, { type: 'history-show-all' }>
      | undefined;
    expect(showAllRow).toBeDefined();
    expect(showAllRow!.hiddenCount).toBe(8);

    const historyRows = result.flatRows.filter((row) => row.type === 'history-item');
    expect(historyRows).toHaveLength(2);
  });
});
