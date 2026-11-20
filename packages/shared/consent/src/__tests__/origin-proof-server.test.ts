import { timingSafeEqual } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { verifyOriginProof } from '../origin-proof-server';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, timingSafeEqual: vi.fn(crypto.timingSafeEqual) };
});

const CURRENT_SECRET = 'current-origin-proof-fixture-at-least-32-bytes';
const NEXT_SECRET = 'next-origin-proof-fixture-at-least-32-bytes';

describe('verifyOriginProof', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([[], [undefined], ['', '   '], ['short'], ['a'.repeat(31)]])(
    'remains unconfigured without a usable secret: %j',
    (...secrets) => {
      expect(verifyOriginProof(CURRENT_SECRET, secrets)).toBe('unconfigured');
    },
  );

  it.each([undefined, '', '  ', 'wrong', `${CURRENT_SECRET}, ${CURRENT_SECRET}`])(
    'rejects a missing, wrong or repeated proof: %j',
    (presented) => {
      expect(verifyOriginProof(presented, [CURRENT_SECRET])).toBe('unproven');
    },
  );

  it.each([CURRENT_SECRET, NEXT_SECRET])('accepts either rotation secret: %s', (presented) => {
    expect(verifyOriginProof(presented, [CURRENT_SECRET, NEXT_SECRET])).toBe('proven');
    // A first-slot match must not skip the comparison against the next secret.
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('compares every configured secret when none matches', () => {
    expect(verifyOriginProof('wrong', [CURRENT_SECRET, NEXT_SECRET])).toBe('unproven');
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
  });

  it('permits rotation while the primary is absent or too short', () => {
    expect(verifyOriginProof(NEXT_SECRET, [undefined, NEXT_SECRET])).toBe('proven');
    expect(verifyOriginProof(NEXT_SECRET, ['short', NEXT_SECRET])).toBe('proven');
  });

  it('preserves whitespace normalization for both the configured and presented proof', () => {
    expect(verifyOriginProof(` ${CURRENT_SECRET} `, [`\t${CURRENT_SECRET}\n`])).toBe('proven');
  });

  it('requires 32 UTF-8 bytes after trimming, rather than 32 characters', () => {
    expect(verifyOriginProof('é'.repeat(16), ['é'.repeat(16)])).toBe('proven');
    expect(verifyOriginProof('é'.repeat(15), ['é'.repeat(15)])).toBe('unconfigured');
    expect(verifyOriginProof('a'.repeat(31), [` ${'a'.repeat(31)} `])).toBe('unconfigured');
    expect(verifyOriginProof('a'.repeat(32), ['a'.repeat(32)])).toBe('proven');
  });
});
