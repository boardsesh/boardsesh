import { describe, expect, it } from 'vite-plus/test';
import { decodeClimbLogsCursor, encodeClimbLogsCursor } from '../utils/climb-logs-cursor';

const encodeRaw = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');

describe('climb logs cursor', () => {
  it('round-trips the timestamp verbatim', () => {
    // The column is timezone-less. Any Date round trip would shift this string.
    const climbedAt = '2026-05-01 18:00:00.123456';

    expect(decodeClimbLogsCursor(encodeClimbLogsCursor({ climbedAt, id: 42n }))).toEqual({ climbedAt, id: 42n });
  });

  it('accepts the T-separated form without a fraction', () => {
    const cursor = encodeClimbLogsCursor({ climbedAt: '2026-05-01T18:00:00', id: 1n });

    expect(decodeClimbLogsCursor(cursor)?.climbedAt).toBe('2026-05-01T18:00:00');
  });

  it('round-trips an id past 2^53 without losing a digit', () => {
    const id = 9007199254740993n;

    expect(decodeClimbLogsCursor(encodeClimbLogsCursor({ climbedAt: '2026-05-01 18:00:00', id }))?.id).toBe(id);
  });

  it('produces base64url output', () => {
    expect(encodeClimbLogsCursor({ climbedAt: '2026-05-01 18:00:00', id: 999999n })).not.toMatch(/[+/=]/);
  });

  it.each([
    ['garbage that is not base64 JSON', '%%%not-a-cursor%%%'],
    ['an empty string', ''],
    ['a JSON array', encodeRaw([1, 2])],
    ['a JSON null', encodeRaw(null)],
    ['another version', encodeRaw({ v: 2, t: '2026-05-01 18:00:00', i: '1' })],
    ['a missing version', encodeRaw({ t: '2026-05-01 18:00:00', i: '1' })],
    ['a missing timestamp', encodeRaw({ v: 1, i: '1' })],
    ['a missing id', encodeRaw({ v: 1, t: '2026-05-01 18:00:00' })],
    ['a numeric id', encodeRaw({ v: 1, t: '2026-05-01 18:00:00', i: 1 })],
    ['a non-numeric id', encodeRaw({ v: 1, t: '2026-05-01 18:00:00', i: '1 or 1=1' })],
    ['a negative id', encodeRaw({ v: 1, t: '2026-05-01 18:00:00', i: '-1' })],
    ['an id past the bigint range', encodeRaw({ v: 1, t: '2026-05-01 18:00:00', i: '9999999999999999999' })],
    ['a timestamp with SQL after it', encodeRaw({ v: 1, t: "2026-01-01'; drop", i: '1' })],
    ['a date with no time', encodeRaw({ v: 1, t: '2026-01-01', i: '1' })],
    ['a zoned timestamp', encodeRaw({ v: 1, t: '2026-05-01T18:00:00.000Z', i: '1' })],
    ['a timestamp that is not a string', encodeRaw({ v: 1, t: 1777658400000, i: '1' })],
  ])('returns null for %s', (_label, cursor) => {
    expect(decodeClimbLogsCursor(cursor)).toBeNull();
  });
});
