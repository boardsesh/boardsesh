import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Contract consumed by released Expo clients and Garmin PairingView/TokenStore.
 * Deliberately validates the legacy wire shape, not Better Auth's cookie/token
 * response. This helper alone is not evidence of a working compatibility facade.
 */
const legacyTokenPairSchema = z.object({
  jwt: z.string().min(1),
  refreshToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(),
  userId: z.string().min(1),
});

export async function assertLegacyNativeTokenPair(
  response: unknown,
  verificationKey: Uint8Array,
  expectedUserId: string,
) {
  const tokenPair = legacyTokenPairSchema.parse(response);
  const verified = await jwtVerify(tokenPair.jwt, verificationKey, {
    algorithms: ['HS256'],
    issuer: 'boardsesh',
    audience: 'boardsesh-mobile',
    requiredClaims: ['sub', 'iat', 'exp'],
    clockTolerance: 60,
  });
  assert.equal(verified.protectedHeader.typ, 'JWT');
  assert.equal(verified.payload.sub, expectedUserId);
  assert.equal(tokenPair.userId, expectedUserId);
  assert.equal(verified.payload.exp! - verified.payload.iat!, 7 * 24 * 60 * 60);
  // Existing issuance computes Date.now() separately from JWT second rounding.
  assert.ok(Math.abs(Date.parse(tokenPair.expiresAt) - verified.payload.exp! * 1000) < 1000);
  return verified.payload;
}
