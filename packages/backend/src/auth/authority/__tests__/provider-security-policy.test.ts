import { describe, expect, it } from 'vite-plus/test';
import {
  captureProviderSecurityMethodsConfiguration,
  googleReauthenticationDeadline,
  isUsableProviderIdentity,
  isUsableProviderPassword,
} from '../provider-security-policy';
import { providerCredentialHash } from '../provider-security-result';

describe('provider security proof boundaries', () => {
  const now = new Date('2026-11-13T12:00:00.000Z');
  const seconds = now.getTime() / 1000;
  const intentExpiry = new Date(now.getTime() + 15 * 60_000);

  it('keeps the original Google authentication deadline through a later token issuance', () => {
    const authenticatedAt = seconds - 299;
    expect(googleReauthenticationDeadline(authenticatedAt, seconds + 3600, now, intentExpiry)).toEqual(
      new Date(now.getTime() + 1000),
    );
    expect(
      googleReauthenticationDeadline(authenticatedAt, seconds + 3600, new Date(now.getTime() + 1001), intentExpiry),
    ).toBeNull();
    for (const unproved of [undefined, null, String(seconds), seconds + 1, seconds - 301, Number.NaN])
      expect(googleReauthenticationDeadline(unproved, seconds + 3600, now, intentExpiry)).toBeNull();
  });

  it('caps proof authority to the source token and operation deadlines', () => {
    expect(googleReauthenticationDeadline(seconds, seconds + 5, now, intentExpiry)).toEqual(
      new Date(now.getTime() + 5000),
    );
    const shortIntent = new Date(now.getTime() + 2000);
    expect(googleReauthenticationDeadline(seconds, seconds + 3600, now, shortIntent)).toEqual(shortIntent);
    expect(googleReauthenticationDeadline(seconds, seconds, now, intentExpiry)).toBeNull();
  });

  it('does not count Facebook, stale imports or incomplete provider settings as a usable alternative', () => {
    const configured = captureProviderSecurityMethodsConfiguration({
      GOOGLE_CLIENT_ID: 'configured-client',
      GOOGLE_CLIENT_SECRET: 'configured-secret',
      FACEBOOK_CLIENT_ID: 'historical-client',
      FACEBOOK_CLIENT_SECRET: 'historical-secret',
    });
    const identity = { userId: 'actor', provider: 'google', subject: 'owned-subject', generation: 4 };
    expect(configured.configuredProviders).toEqual(['google']);
    expect(configured.googleReauthenticationEnabled).toBe(false);
    expect(isUsableProviderIdentity(identity, 'actor', 4, configured)).toBe(true);
    expect(isUsableProviderIdentity({ ...identity, provider: 'facebook' }, 'actor', 4, configured)).toBe(false);
    expect(isUsableProviderIdentity(identity, 'actor', 5, configured)).toBe(false);
    expect(isUsableProviderIdentity(identity, 'another-actor', 4, configured)).toBe(false);
    expect(
      isUsableProviderIdentity(
        identity,
        'actor',
        4,
        captureProviderSecurityMethodsConfiguration({ GOOGLE_CLIENT_ID: 'client' }),
      ),
    ).toBe(false);
    expect(isUsableProviderPassword(null, 'actor', 4)).toBe(false);
    expect(
      isUsableProviderPassword({ userId: 'actor', generation: 4, passwordHash: 'unsupported-hash' }, 'actor', 4),
    ).toBe(false);
  });

  it('binds an ACK receipt to the caller-held exact candidate and credential kind', () => {
    const original = { kind: 'canonical-token' as const, credential: 'exact-caller-held-token' };
    expect(providerCredentialHash(original)).toMatch(/^[a-f0-9]{64}$/);
    expect(providerCredentialHash({ ...original })).toBe(providerCredentialHash(original));
    expect(providerCredentialHash({ ...original, credential: 'another-token' })).not.toBe(
      providerCredentialHash(original),
    );
    expect(providerCredentialHash({ ...original, kind: 'legacy-jwe' })).not.toBe(providerCredentialHash(original));
  });
});
