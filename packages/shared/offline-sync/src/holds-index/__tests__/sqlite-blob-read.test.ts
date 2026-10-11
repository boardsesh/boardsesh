import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../testing/sqlite-test-db';
import { decodeSqliteBlobHex } from '../query';

describe('decodeSqliteBlobHex', () => {
  it('round-trips every byte through SQLite hex text in both cases', async () => {
    const db = createTestDatabase();
    try {
      const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      const row = await db.getFirstAsync<{ hex: string }>('SELECT hex(?) AS hex', [bytes]);
      expect(typeof row?.hex).toBe('string');
      expect(decodeSqliteBlobHex(row?.hex)).toEqual(bytes);
      expect(decodeSqliteBlobHex(row?.hex.toLowerCase())).toEqual(bytes);
    } finally {
      db.close();
    }
  });

  it('preserves an empty BLOB', () => {
    expect(decodeSqliteBlobHex('')).toEqual(new Uint8Array(0));
  });

  it.each([null, undefined, 123, new Uint8Array([0]), '0', 'abc', '0g', 'g0', ' 0', '0 ', '0x', 'ＦＦ', '00\n0'])(
    'rejects nonstrings and malformed hex: %s',
    (hex) => expect(decodeSqliteBlobHex(hex)).toBeNull(),
  );
});
