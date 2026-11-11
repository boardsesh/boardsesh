import { describe, expect, it } from 'vitest';
import { ABSENT_PASSWORD_HASH, PASSWORD_HASH_COST } from '../password-hash';

// Every stored password hash is cost 12 and none is ever rehashed. The stand-in
// for an unknown address must match them, and new writes must not move away
// from them, or sign-in timing tells a caller which addresses have accounts.
// The two must stay equal until every stored hash has been rehashed.
describe('password hash cost', () => {
  it('compares an unknown address at cost 12, the cost of every stored hash', () => {
    const parsed = /^\$2b\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(ABSENT_PASSWORD_HASH);
    expect(parsed).not.toBeNull();
    expect(parsed?.[1]).toBe('12');
  });

  it('writes new hashes at cost 12', () => {
    expect(PASSWORD_HASH_COST).toBe(12);
  });
});
