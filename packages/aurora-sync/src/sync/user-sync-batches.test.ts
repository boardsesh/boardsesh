import { describe, expect, it } from 'vitest';
import { userSyncWriteBatches } from './user-sync-batches';

describe('userSyncWriteBatches', () => {
  it('bounds ordinary table writes while preserving every row in order', () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({ name: `tag-${index}` }));
    const batches = [...userSyncWriteBatches('tags', rows)];
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 1]);
    expect(batches.flat()).toEqual(rows);
  });

  it('applies all ascent tombstones before live claims, including string flags', () => {
    const live = Array.from({ length: 101 }, (_, index) => ({ uuid: `ascent-${index}`, is_listed: true }));
    const tombstones = [
      { uuid: 'ascent-0', is_listed: false },
      { uuid: 'released-native', is_listed: '0' },
    ];
    const batches = [...userSyncWriteBatches('ascents', [...live, ...tombstones])];
    expect(batches[0]).toEqual(tombstones);
    expect(batches.slice(1).flat()).toEqual(live);
    expect(batches.map((batch) => batch.length)).toEqual([2, 100, 1]);
  });

  it.each(['ascents', 'bids'])('keeps duplicate %s IDs together across wire-row boundaries', (tableName) => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ uuid: `log-${index}`, comment: 'first' }));
    const finalCopy = { uuid: 'log-0', comment: 'last' };
    const batches = [...userSyncWriteBatches(tableName, [...rows, finalCopy])];
    expect(batches).toHaveLength(2);
    expect(batches[0]?.slice(0, 2)).toEqual([rows[0], finalCopy]);
    expect(batches[1]).toEqual([rows[100]]);
    expect(batches.flat()).toHaveLength(102);
    expect(batches.every((batch) => new Set(batch.map((row) => row.uuid)).size <= 100)).toBe(true);
  });

  it('globally sorts circuits and keeps the final duplicate in its single atomic unit', () => {
    const rows = [
      { uuid: 'z', name: 'first' },
      { uuid: 'a', name: 'earlier lock' },
      { uuid: 'z', name: 'last' },
      { uuid: ' ', name: 'invalid' },
      { name: 'missing id' },
    ];
    expect([...userSyncWriteBatches('circuits', rows)]).toEqual([[rows[1]], [rows[0], rows[2]], [rows[3], rows[4]]]);
  });
});
