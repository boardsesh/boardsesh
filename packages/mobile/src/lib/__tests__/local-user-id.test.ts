import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getAuthToken } = vi.hoisted(() => ({ getAuthToken: vi.fn<() => Promise<string | null>>() }));

vi.mock('../auth-store', () => ({ getAuthToken }));

import { readLocalUserId } from '../local-user-id';

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nativeJwt(userId: string): string {
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(JSON.stringify({ sub: userId }))}.signature`;
}

describe('readLocalUserId (native)', () => {
  beforeEach(() => {
    getAuthToken.mockReset();
  });

  it('reads the sub claim of the stored JWT', async () => {
    getAuthToken.mockResolvedValue(nativeJwt('user-42'));
    await expect(readLocalUserId()).resolves.toBe('user-42');
  });

  it('answers undefined when the keychain has no token', async () => {
    getAuthToken.mockResolvedValue(null);
    await expect(readLocalUserId()).resolves.toBeUndefined();
  });

  it('answers undefined for a malformed token', async () => {
    getAuthToken.mockResolvedValue('not-a-jwt');
    await expect(readLocalUserId()).resolves.toBeUndefined();
  });

  it('answers undefined for the 5-segment compact JWE the browser holds (#4321)', async () => {
    // The exact shape `auth-store.web.ts` stores as `backendToken`: a compact
    // JWE (header.encryptedKey.iv.ciphertext.tag), whose claims are encrypted.
    // This is why the web fork exists — no decode can recover an id from it.
    const compactJwe = [
      base64Url('{"alg":"dir","enc":"A256GCM"}'),
      '',
      base64Url('initvector'),
      base64Url('ciphertext-nobody-can-read'),
      base64Url('authtag'),
    ].join('.');
    getAuthToken.mockResolvedValue(compactJwe);
    await expect(readLocalUserId()).resolves.toBeUndefined();
  });
});
