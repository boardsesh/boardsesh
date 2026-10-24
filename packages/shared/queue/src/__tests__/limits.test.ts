import { describe, it, expect } from 'vitest';
import { clampQueueAroundCurrent, clampQueueWindow, MAX_SYNCED_QUEUE_ITEMS } from '../limits';

function rows(count: number): number[] {
  return Array.from({ length: count }, (_unused, index) => index);
}

describe('clampQueueWindow', () => {
  it('hands back a queue that already fits as the same array', () => {
    const queue = rows(MAX_SYNCED_QUEUE_ITEMS);
    expect(clampQueueWindow(queue, 10)).toBe(queue);
  });

  it('keeps the anchor and the climbs after it when they fill the window', () => {
    const window = clampQueueWindow(rows(2000), 10);
    expect(window).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(window[0]).toBe(10);
    expect(window.at(-1)).toBe(509);
  });

  it('fills from before the anchor when it sits near the end', () => {
    // Row 550 of 600: a plain slice(0, 500) would drop it.
    const window = clampQueueWindow(rows(600), 550);
    expect(window).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(window).toContain(550);
    expect(window[0]).toBe(100);
    expect(window.at(-1)).toBe(599);
  });

  it('keeps the first climbs when there is no anchor', () => {
    expect(clampQueueWindow(rows(600), -1)).toEqual(rows(MAX_SYNCED_QUEUE_ITEMS));
    expect(clampQueueWindow(rows(600), 600)).toEqual(rows(MAX_SYNCED_QUEUE_ITEMS));
  });

  it('honours a smaller max', () => {
    expect(clampQueueWindow(rows(10), 8, 4)).toEqual([6, 7, 8, 9]);
    expect(clampQueueWindow(rows(10), 2, 4)).toEqual([2, 3, 4, 5]);
  });
});

describe('clampQueueAroundCurrent', () => {
  function items(count: number): { uuid: string }[] {
    return Array.from({ length: count }, (_unused, index) => ({ uuid: `row-${index}` }));
  }

  it('hands back a queue that already fits as the same array', () => {
    const queue = items(MAX_SYNCED_QUEUE_ITEMS);
    expect(clampQueueAroundCurrent(queue, queue[499])).toBe(queue);
  });

  it('windows around the current item by uuid, not by reference', () => {
    const window = clampQueueAroundCurrent(items(601), { uuid: 'row-600' });
    expect(window).toHaveLength(MAX_SYNCED_QUEUE_ITEMS);
    expect(window[0]?.uuid).toBe('row-101');
    expect(window.at(-1)?.uuid).toBe('row-600');
  });

  it('keeps the first items without a current item, or when it is not queued', () => {
    expect(clampQueueAroundCurrent(items(600), null).at(-1)?.uuid).toBe('row-499');
    expect(clampQueueAroundCurrent(items(600), { uuid: 'elsewhere' }).at(-1)?.uuid).toBe('row-499');
  });
});
