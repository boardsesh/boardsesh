import { describe, expect, it } from 'vitest';
import {
  DEVICE_TOKEN_LIFETIME_SECONDS,
  DEVICE_TOKEN_OTHER_SECRET_ENV,
  DEVICE_TOKEN_SECRET_ENV,
  mintDeviceToken,
  readDeviceTokenSecret,
  verifyDeviceToken,
} from '../device-token';

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const secret = randomSecret();
const owner = 'user-owner-1';
const now = new Date('2026-11-17T12:00:00.000Z');
const days = (count: number) => count * 86_400_000;
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

describe('device token codec', () => {
  it('round-trips for the account it was minted for, without carrying the user id', async () => {
    const minted = await mintDeviceToken({ userId: owner, secret, now });
    expect(minted.token).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(minted.token).not.toContain(owner);
    expect(await verifyDeviceToken(minted.token, { userId: owner, secret, now })).toEqual({
      tokenId: minted.tokenId,
      issuedAt: now,
      expiresAt: at(days(400)),
    });
  });

  it('mints a fresh random id each time', async () => {
    const minted = await Promise.all(Array.from({ length: 50 }, () => mintDeviceToken({ userId: owner, secret, now })));
    expect(new Set(minted.map(({ tokenId }) => tokenId)).size).toBe(50);
  });

  it('gives nothing for another account, even one whose id shares a prefix', async () => {
    const { token } = await mintDeviceToken({ userId: owner, secret, now });
    for (const userId of ['user-owner-2', 'user-owner-1 ', 'user-owner-10', ''])
      expect(await verifyDeviceToken(token, { userId, secret, now })).toBeNull();
  });

  it('reads a forged, altered or foreign-secret token as absent', async () => {
    const { token, tokenId } = await mintDeviceToken({ userId: owner, secret, now });
    const [version, , issuedAt, signature] = token.split('.');
    const otherId = (await mintDeviceToken({ userId: owner, secret, now })).tokenId;
    const altered = [
      `${version}.${otherId}.${issuedAt}.${signature}`,
      `${version}.${tokenId}.${Number(issuedAt) + 1}.${signature}`,
      `${version}.${tokenId}.${issuedAt}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
      `v2.${tokenId}.${issuedAt}.${signature}`,
    ];
    for (const candidate of altered)
      expect(await verifyDeviceToken(candidate, { userId: owner, secret, now })).toBeNull();
    const otherSecret = randomSecret();
    expect(await verifyDeviceToken(token, { userId: owner, secret: otherSecret, now })).toBeNull();
    const foreign = (await mintDeviceToken({ userId: owner, secret: otherSecret, now })).token;
    expect(await verifyDeviceToken(foreign, { userId: owner, secret, now })).toBeNull();
  });

  it('reads a non-canonical encoding of a real MAC as absent', async () => {
    const { token } = await mintDeviceToken({ userId: owner, secret, now });
    // The last of 43 base64url characters carries 2 unused bits; set them.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = token.at(-1) ?? 'A';
    const variant = `${token.slice(0, -1)}${alphabet[alphabet.indexOf(last) | 3]}`;
    if (variant !== token) expect(await verifyDeviceToken(variant, { userId: owner, secret, now })).toBeNull();
  });

  it('reads a zero-padded issued-at as absent: one token, one spelling', async () => {
    const { token } = await mintDeviceToken({ userId: owner, secret, now });
    const [version, tokenId, issuedAt, signature] = token.split('.');
    // Same id, same MAC, same number, different text.
    for (const padded of [`0${issuedAt}`, `00${issuedAt}`])
      expect(
        await verifyDeviceToken(`${version}.${tokenId}.${padded}.${signature}`, { userId: owner, secret, now }),
      ).toBeNull();
    expect(await verifyDeviceToken(`${version}.${tokenId}.0.${signature}`, { userId: owner, secret, now })).toBeNull();
  });

  it('reads malformed input as absent, never throws', async () => {
    for (const input of [undefined, null, 42, {}, '', 'v1', 'v1...', `v1.${'a'.repeat(200)}`, 'x'.repeat(10_000)])
      expect(await verifyDeviceToken(input, { userId: owner, secret, now })).toBeNull();
  });

  it('expires after 400 days and refuses one issued in the future', async () => {
    const { token } = await mintDeviceToken({ userId: owner, secret, now });
    const verifyAt = (moment: Date) => verifyDeviceToken(token, { userId: owner, secret, now: moment });
    expect(await verifyAt(at(DEVICE_TOKEN_LIFETIME_SECONDS * 1000 - 1000))).not.toBeNull();
    expect(await verifyAt(at(days(400)))).toBeNull();
    // Five minutes of clock difference between the web and the backend is tolerated, an hour is not.
    expect(await verifyAt(at(-60_000))).not.toBeNull();
    expect(await verifyAt(at(-3_600_000))).toBeNull();
  });

  it('refuses to mint without a user, with a short secret or a malformed id', async () => {
    await expect(mintDeviceToken({ userId: '', secret, now })).rejects.toThrow();
    await expect(mintDeviceToken({ userId: owner, secret: 'short', now })).rejects.toThrow();
    await expect(mintDeviceToken({ userId: owner, secret, now, tokenId: 'not-an-id' })).rejects.toThrow();
  });
});

describe('device token secret', () => {
  it('is off when unset and invalid when short, padded or shared with another auth secret', () => {
    expect(readDeviceTokenSecret({})).toEqual({ problem: 'unset' });
    expect(readDeviceTokenSecret({ [DEVICE_TOKEN_SECRET_ENV]: '' })).toEqual({ problem: 'unset' });
    expect(readDeviceTokenSecret({ [DEVICE_TOKEN_SECRET_ENV]: 'x'.repeat(31) })).toEqual({ problem: 'invalid' });
    expect(readDeviceTokenSecret({ [DEVICE_TOKEN_SECRET_ENV]: ` ${secret}` })).toEqual({ problem: 'invalid' });
    expect(DEVICE_TOKEN_OTHER_SECRET_ENV).toContain('AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY');
    for (const other of DEVICE_TOKEN_OTHER_SECRET_ENV)
      expect(readDeviceTokenSecret({ [DEVICE_TOKEN_SECRET_ENV]: secret, [other]: secret })).toEqual({
        problem: 'invalid',
      });
    expect(readDeviceTokenSecret({ [DEVICE_TOKEN_SECRET_ENV]: secret })).toEqual({ secret });
  });
});
