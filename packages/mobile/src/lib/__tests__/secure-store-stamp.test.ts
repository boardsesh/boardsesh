import { describe, it, expect, vi } from 'vitest';

// The pure half of the namespace stamp (#5345): the fingerprint, the wire format,
// and the freshness rule. The I/O half is exercised end to end through auth-store
// in secure-store-rollforward.test.ts.
//
// The rule these pin is the whole fix, and it is easy to "simplify" into
// something wrong: every uncertainty must resolve to v2-current, because the only
// case that may reach legacy-newer is the rolled-back build's signature — legacy
// changed while v2 did not.

process.env.EXPO_OS = 'ios';

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

const {
  NAMESPACE_STAMP_SUFFIX,
  fingerprintSecureValue,
  namespaceStampKey,
  parseNamespaceStamp,
  resolveNamespaceVerdict,
  serializeNamespaceStamp,
} = await import('../secure-store-stamp');

const V2_TOKEN = 'jwt-before-the-rollback';
const LEGACY_TOKEN = 'jwt-written-by-the-rolled-back-build';

describe('fingerprintSecureValue', () => {
  it('is stable for the same value and different for a changed one', () => {
    expect(fingerprintSecureValue(V2_TOKEN)).toBe(fingerprintSecureValue(V2_TOKEN));
    expect(fingerprintSecureValue(V2_TOKEN)).not.toBe(fingerprintSecureValue(LEGACY_TOKEN));
  });

  it('never contains the value it fingerprints', () => {
    expect(fingerprintSecureValue(V2_TOKEN)).not.toContain('jwt');
  });

  it('separates values that differ only in length', () => {
    expect(fingerprintSecureValue('abc')).not.toBe(fingerprintSecureValue('abc '));
  });
});

describe('the stamp wire format', () => {
  it('round-trips a fully known stamp', () => {
    const stamp = { generation: 7, v2: 'a', legacy: 'b' };

    expect(parseNamespaceStamp(serializeNamespaceStamp(stamp))).toEqual(stamp);
  });

  it('keeps "we left it empty" distinct from "we do not know"', () => {
    const emptied = parseNamespaceStamp(serializeNamespaceStamp({ generation: 1, v2: 'a', legacy: null }));
    const unknown = parseNamespaceStamp(serializeNamespaceStamp({ generation: 1, v2: 'a', legacy: undefined }));

    // Collapsing these would let a rejected legacy write read back as a confirmed
    // empty namespace, and a live credential would then out-rank a tombstone.
    expect(emptied?.legacy).toBeNull();
    expect(unknown?.legacy).toBeUndefined();
  });

  it('treats an unreadable stamp as no stamp at all', () => {
    expect(parseNamespaceStamp(null)).toBeNull();
    expect(parseNamespaceStamp('not json')).toBeNull();
    expect(parseNamespaceStamp('"a string"')).toBeNull();
  });
});

describe('resolveNamespaceVerdict', () => {
  const fresh = { generation: 3, v2: fingerprintSecureValue(V2_TOKEN), legacy: fingerprintSecureValue(V2_TOKEN) };

  it('picks legacy when it moved under a build that keeps no stamps', () => {
    // The #5345 signature: v2 is exactly as we left it, legacy is not. Only JS
    // that predates the v2 namespace writes legacy without stamping.
    expect(resolveNamespaceVerdict(fresh, V2_TOKEN, LEGACY_TOKEN)).toBe('legacy-newer');
  });

  it('keeps v2 when there is no stamp to compare against', () => {
    expect(resolveNamespaceVerdict(null, V2_TOKEN, LEGACY_TOKEN)).toBe('v2-current');
  });

  it('keeps v2 when our own legacy write could not be confirmed', () => {
    // The sign-out tombstone on a locked device: v2 holds the tombstone, legacy
    // still holds the live credential, and the credential must not win.
    const unconfirmed = { generation: 3, v2: fingerprintSecureValue(V2_TOKEN), legacy: undefined };

    expect(resolveNamespaceVerdict(unconfirmed, V2_TOKEN, LEGACY_TOKEN)).toBe('v2-current');
  });

  it('keeps v2 when v2 itself moved since the stamp', () => {
    // A v2-aware build wrote v2 and its legacy mirror was rejected. v2 is the
    // newer half of that write.
    const stale = {
      generation: 3,
      v2: fingerprintSecureValue('something-older'),
      legacy: fingerprintSecureValue(LEGACY_TOKEN),
    };

    expect(resolveNamespaceVerdict(stale, V2_TOKEN, LEGACY_TOKEN)).toBe('v2-current');
  });

  it('keeps v2 when legacy is exactly what we last put there', () => {
    const mirrored = {
      generation: 3,
      v2: fingerprintSecureValue(V2_TOKEN),
      legacy: fingerprintSecureValue(LEGACY_TOKEN),
    };

    expect(resolveNamespaceVerdict(mirrored, V2_TOKEN, LEGACY_TOKEN)).toBe('v2-current');
  });
});

describe('stamp keys', () => {
  it('derives its own key from the value key', () => {
    expect(namespaceStampKey('boardsesh_jwt')).toBe(`boardsesh_jwt${NAMESPACE_STAMP_SUFFIX}`);
  });
});
