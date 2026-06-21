// @ts-nocheck — __tests__ is excluded from tsconfig.json, so the type-aware
// lint can't resolve node globals or `node:*` specifiers. Type-checking happens
// at test-run time via vitest.
import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const TEST_SECRET = 'test-secret-for-integration-state';
process.env.NEXTAUTH_SECRET = TEST_SECRET;

// The signing key is HKDF-derived from NEXTAUTH_SECRET (domain separation from
// NextAuth session tokens) — hand-crafted payloads must sign with the same
// derived key to exercise the checks past signature verification.
const DERIVED_KEY = Buffer.from(
  crypto.hkdfSync('sha256', TEST_SECRET, '', 'boardsesh-integration-oauth-tokens-v1', 32),
);

import {
  signIntegrationState,
  verifyIntegrationState,
  signIntegrationHandoff,
  verifyIntegrationHandoff,
} from '../integrations/state';

describe('integration state token', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('roundtrips a userId + provider', () => {
    const state = signIntegrationState({ userId: 'user-42', provider: 'strava' });
    const verified = verifyIntegrationState(state);
    expect(verified).toMatchObject({ userId: 'user-42', provider: 'strava' });
    expect(typeof verified?.nonce).toBe('string');
    expect(verified?.nonce.length).toBeGreaterThan(0);
  });

  it('rejects a tampered signature', () => {
    const state = signIntegrationState({ userId: 'user-42', provider: 'strava' });
    const [payload, signature] = state.split('.');
    // Flip the last character of the signature.
    const lastChar = signature.slice(-1) === 'A' ? 'B' : 'A';
    const tampered = `${payload}.${signature.slice(0, -1)}${lastChar}`;
    expect(verifyIntegrationState(tampered)).toBeNull();
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const state = signIntegrationState({ userId: 'user-42', provider: 'strava' });
    const [, signature] = state.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        purpose: 'oauth-state',
        userId: 'attacker',
        provider: 'strava',
        nonce: 'x',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(verifyIntegrationState(`${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const state = signIntegrationState({ userId: 'user-42', provider: 'strava' });
    // Advance past the 10-minute lifetime + skew tolerance.
    vi.setSystemTime(now + 11 * 60 * 1000);
    expect(verifyIntegrationState(state)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyIntegrationState('')).toBeNull();
    expect(verifyIntegrationState('no-dot')).toBeNull();
    expect(verifyIntegrationState('a.b.c')).toBeNull();
    expect(verifyIntegrationState('.sig')).toBeNull();
    expect(verifyIntegrationState('payload.')).toBeNull();
  });

  it('rejects an unsupported provider in a validly-signed payload', () => {
    // Sign a payload with an unknown provider directly so the signature is valid
    // but verification must still reject the unsupported provider.
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        purpose: 'oauth-state',
        userId: 'user-42',
        provider: 'garmin',
        nonce: 'n',
        iat: now,
        exp: now + 600,
      }),
    ).toString('base64url');
    const signature = crypto.createHmac('sha256', DERIVED_KEY).update(payload).digest('base64url');
    expect(verifyIntegrationState(`${payload}.${signature}`)).toBeNull();
  });

  it('callback provider mismatch is detectable by the caller', () => {
    // verifyIntegrationState returns the embedded provider; the callback compares
    // it against the URL's provider segment. Confirm the embedded provider is
    // surfaced so a mismatch can be caught.
    const state = signIntegrationState({ userId: 'user-1', provider: 'strava' });
    const verified = verifyIntegrationState(state);
    expect(verified?.provider).toBe('strava');
  });
});

describe('integration OAuth handoff token', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('roundtrips a userId + provider with a nonce', () => {
    const handoff = signIntegrationHandoff({ userId: 'user-7', provider: 'strava' });
    const verified = verifyIntegrationHandoff(handoff);
    expect(verified).toMatchObject({ userId: 'user-7', provider: 'strava' });
    expect(typeof verified?.nonce).toBe('string');
  });

  it('is purpose-bound: a handoff never verifies as an OAuth state and vice versa', () => {
    const handoff = signIntegrationHandoff({ userId: 'user-7', provider: 'strava' });
    const state = signIntegrationState({ userId: 'user-7', provider: 'strava' });
    expect(verifyIntegrationState(handoff)).toBeNull();
    expect(verifyIntegrationHandoff(state)).toBeNull();
  });

  it('expires after its 60-second lifetime', () => {
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const handoff = signIntegrationHandoff({ userId: 'user-7', provider: 'strava' });
    vi.setSystemTime(now + 2 * 60 * 1000);
    expect(verifyIntegrationHandoff(handoff)).toBeNull();
  });
});
