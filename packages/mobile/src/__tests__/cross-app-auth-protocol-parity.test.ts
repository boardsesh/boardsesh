import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Expo-web ↔ Next.js auth coordination protocol (Web Lock name,
// BroadcastChannel name, NextAuth storage-event key, the auth-token-cleared
// message shape, and the guarded sign-out form fields + 409 error code) is a
// cross-package contract, but each element is re-declared as an independent
// string literal in packages/web and packages/mobile. If either side renames a
// constant, nothing fails loudly — cross-tab session refresh and cross-app
// response-order serialization silently stop working, surfacing only as rare
// account-switch races in production. This guard reads both sides and asserts
// the literals stay identical, the same cross-boundary pattern this package
// already uses in web-runtime-dependency-parity.test.ts.

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

// Web files.
const webFetchLock = read('../../../web/app/lib/auth/nextauth-cookie-fetch-lock.ts');
const webSessionProvider = read('../../../web/app/components/providers/session-provider.tsx');
const webNextAuthRoute = read('../../../web/app/api/auth/[...nextauth]/route.ts');
// Mobile files.
const mobileCookieLock = read('../lib/auth-cookie-lock.web.ts');
const mobileAuthStore = read('../lib/auth-store.web.ts');
const mobileAuthWeb = read('../lib/auth.web.ts');

function extractConst(source: string, name: string): string {
  // Accept single- or double-quoted literals so a formatter/quote-style change
  // never silently turns a real value into `null` (which would defeat the
  // cross-app equality assertions below).
  const match = source.match(new RegExp(`${name}\\s*=\\s*['"]([^'"]+)['"]`));
  if (!match) throw new Error(`Could not find a string constant named "${name}" — did it get renamed or removed?`);
  return match[1];
}

describe('cross-app Expo-web auth protocol parity', () => {
  it('shares one Web Lock name across web and mobile', () => {
    const webLockName = extractConst(webFetchLock, 'NEXTAUTH_COOKIE_LOCK_NAME');
    const mobileLockName = extractConst(mobileCookieLock, 'AUTH_COOKIE_LOCK_NAME');
    expect(webLockName).toBe('boardsesh-nextauth-cookie-v1');
    expect(mobileLockName).toBe(webLockName);
  });

  it('shares one BroadcastChannel name across every producer and consumer', () => {
    const webFetchLockChannel = extractConst(webFetchLock, 'EXPO_AUTH_CHANNEL_NAME');
    const webProviderChannel = extractConst(webSessionProvider, 'EXPO_AUTH_CHANNEL_NAME');
    const mobileChannel = extractConst(mobileAuthStore, 'AUTH_TOKEN_CHANNEL_NAME');
    expect(webFetchLockChannel).toBe('boardsesh-expo-web-auth-v1');
    expect(webProviderChannel).toBe(webFetchLockChannel);
    expect(mobileChannel).toBe(webFetchLockChannel);
  });

  it('shares one NextAuth storage-event key across web and mobile', () => {
    const webStorageKey = extractConst(webSessionProvider, 'NEXT_AUTH_STORAGE_KEY');
    const mobileStorageKey = extractConst(mobileAuthStore, 'NEXT_AUTH_STORAGE_KEY');
    expect(webStorageKey).toBe('nextauth.message');
    expect(mobileStorageKey).toBe(webStorageKey);
  });

  // Quote-agnostic literal match so a formatter/quote-style change on either side
  // can't make a real divergence pass vacuously.
  function quotedLiteral(value: string): RegExp {
    return new RegExp(`['"]${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  }

  it('shares the auth-token-cleared message type and reason values', () => {
    for (const value of ['auth-token-cleared', 'credential-rotation', 'signout-started', 'confirmed-signout']) {
      expect(webFetchLock).toMatch(quotedLiteral(value));
      expect(mobileAuthStore).toMatch(quotedLiteral(value));
    }
  });

  it('shares the guarded sign-out form fields and 409 error code', () => {
    for (const field of ['expectedUserId', 'expectedAuthSessionId']) {
      expect(webFetchLock).toContain(field);
      expect(webNextAuthRoute).toContain(field);
      expect(mobileAuthWeb).toContain(field);
    }
    // The web route emits `signout_identity_changed` as a 409; both clients read it.
    expect(webNextAuthRoute).toMatch(quotedLiteral('signout_identity_changed'));
    expect(mobileAuthWeb).toMatch(quotedLiteral('signout_identity_changed'));
  });
});
