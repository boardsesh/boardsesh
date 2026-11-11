import { describe, expect, it } from 'vitest';
import { ABSENT_PASSWORD_HASH, PASSWORD_HASH_COST } from '../password-hash';

describe('ABSENT_PASSWORD_HASH', () => {
  it('is a bcrypt hash at the cost every stored password is written at', () => {
    const parsed = /^\$2b\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(ABSENT_PASSWORD_HASH);
    expect(parsed).not.toBeNull();
    expect(Number(parsed?.[1])).toBe(PASSWORD_HASH_COST);
  });
});
