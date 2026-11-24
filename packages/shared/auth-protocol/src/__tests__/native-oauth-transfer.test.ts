import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  createNativeOAuthTransferCodec,
  nativeTransferCommandSchema,
  nativeTransferReplySchema,
} from '../native-oauth-transfer';

const secret = 'synthetic-browser-transfer-compatibility-secret';
const now = Date.parse('2026-11-24T12:00:00.000Z');
const nowSeconds = now / 1000;
const codec = createNativeOAuthTransferCodec({
  encode: (text) => Buffer.from(text).toString('base64url'),
  decode: (encoded) => Buffer.from(encoded, 'base64url').toString(),
  hmac: (text, key) => createHmac('sha256', key).update(text).digest('base64url'),
  equal: (actual, expected) => {
    const actualBytes = Buffer.from(actual);
    const expectedBytes = Buffer.from(expected);
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  },
  hash: (text) => createHash('sha256').update(text).digest('hex'),
});
function signed(extra: Record<string, unknown> = {}) {
  const payload = Buffer.from(
    JSON.stringify({ userId: 'source-user', nextPath: '/settings', iat: nowSeconds, exp: nowSeconds + 120, ...extra }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('legacy browser native-transfer codec', () => {
  it.each([undefined, 0, 7])('preserves generation-only source %s without manufacturing proof or age', (generation) => {
    const token = signed(generation === undefined ? {} : { gen: generation });
    expect(codec.readNativeOAuthTransfer(token, secret, now)).toMatchObject({
      userId: 'source-user',
      nextPath: '/settings',
      generation: generation ?? 0,
    });
    expect(codec.readNativeOAuthTransfer(token, secret, now)).not.toHaveProperty('credentialProof');
  });
  it.each([false, true])('preserves the complete signed source proof with unknown-age=%s', (unknownAge) => {
    const token = signed({
      gen: 3,
      authSessionId: 'original-sid',
      ...(unknownAge ? {} : { auth_time: nowSeconds - 3600, link_guarded: true }),
      legacy_no_sid: true,
    });
    expect(codec.readNativeOAuthTransfer(token, secret, now)?.credentialProof).toEqual({
      version: 1,
      userId: 'source-user',
      authSessionId: 'original-sid',
      generation: 3,
      authenticatedAt: unknownAge ? null : new Date(now - 3_600_000).toISOString(),
      linkGuarded: !unknownAge,
      requiresAccountCutoff: true,
    });
  });
  it('matches the old payload-keyed durable marker exactly and retains its cleanup margin', () => {
    const token = signed();
    const digest = createHash('sha256')
      .update(`native-oauth-transfer-v1\0${token.split('.')[0]}`)
      .digest('hex');
    expect(codec.nativeOAuthTransferSpentMarker(token, secret)).toEqual({
      identifier: `ba03-web-auth:${digest}`,
      token: digest,
      expires: new Date(now + 425_000),
    });
  });
  it('retains the inclusive integer-second expiry and future-clock boundaries', () => {
    const token = signed();
    expect(codec.readNativeOAuthTransfer(token, secret, now + 125_999)).not.toBeNull();
    expect(codec.readNativeOAuthTransfer(token, secret, now + 126_000)).toBeNull();
    expect(codec.readNativeOAuthTransfer(token, secret, now - 5_000)).not.toBeNull();
    expect(codec.readNativeOAuthTransfer(token, secret, now - 5_001)).toBeNull();
  });
  it.each([
    { exp: nowSeconds + 126 },
    { exp: nowSeconds },
    { gen: -1 },
    { gen: 1.5 },
    { auth_time: nowSeconds - 10 },
    { gen: 3, authSessionId: 'original-sid', legacy_no_sid: false },
  ])('refuses invalid signed source claims %j', (claims) => {
    expect(codec.readNativeOAuthTransfer(signed(claims), secret, now)).toBeNull();
  });
  it('rejects alternate token spellings and an unavailable key', () => {
    const token = signed();
    const [payload, signature] = token.split('.');
    for (const alternate of [
      `${token}.extra`,
      `${payload}.${signature}=`,
      `${payload}.${signature}\n`,
      `${payload}=.${signature}`,
      `${token}x`,
    ]) {
      expect(codec.readNativeOAuthTransfer(alternate, secret, now)).toBeNull();
      expect(codec.nativeOAuthTransferSpentMarker(alternate, secret)).toBeNull();
    }
    expect(codec.readNativeOAuthTransfer(token, '', now)).toBeNull();
  });
  it('keeps the private command and reply strict and rejects source/profile disagreement', () => {
    const metadata = {
      nativeTransferProtocolVersion: 1,
      operation: 'claim',
      requestId: 'f9a29b11-050e-43d9-91e1-c8724a982cb1',
    };
    expect(
      nativeTransferCommandSchema.safeParse({
        ...metadata,
        issuedAt: now,
        payload: { transferToken: signed(), userId: 'forged' },
      }).success,
    ).toBe(false);
    expect(
      nativeTransferReplySchema.safeParse({
        ...metadata,
        outcome: 'claimed',
        user: { id: 'other', email: 'owned@example.test', name: null, image: null },
        sourceGeneration: 3,
        credentialProof: {
          version: 1,
          userId: 'source-user',
          authSessionId: 'source',
          generation: 3,
          authenticatedAt: null,
          linkGuarded: false,
        },
      }).success,
    ).toBe(false);
  });
});
