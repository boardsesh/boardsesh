import { createHash } from 'node:crypto';
import { verifyAuthorityGoogleIdToken } from './authority';
import type { ProviderSecurityMethodsConfiguration } from './provider-security-policy';

export interface VerifiedGoogleAuthenticationAssertion {
  readonly subject: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
  readonly proofBindingHash: string;
}

/** Cryptographic assertion only. The receipt writer checks original auth_time against its locked database clock. */
export async function verifyProviderGoogleAuthenticationAssertion(
  configuration: ProviderSecurityMethodsConfiguration,
  input: { readonly idToken: string; readonly nonce: string },
): Promise<VerifiedGoogleAuthenticationAssertion | null> {
  const audience = configuration.googleAudience;
  const enabled = configuration.googleReauthenticationEnabled;
  const { idToken, nonce } = input;
  if (!enabled || !audience || !nonce || nonce.length > 1024 || !idToken || idToken.length > 16_384) return null;
  const claims = await verifyAuthorityGoogleIdToken({ token: idToken, audience, nonce });
  if (
    !claims ||
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    claims.sub.length > 1024 ||
    typeof claims.auth_time !== 'number' ||
    !Number.isSafeInteger(claims.auth_time) ||
    claims.auth_time <= 0 ||
    typeof claims.exp !== 'number' ||
    !Number.isSafeInteger(claims.exp) ||
    typeof claims.iat !== 'number' ||
    !Number.isSafeInteger(claims.iat) ||
    claims.auth_time > claims.iat ||
    (claims.azp !== undefined && claims.azp !== audience)
  )
    return null;
  return Object.freeze({
    subject: claims.sub,
    authenticatedAt: claims.auth_time,
    expiresAt: claims.exp,
    proofBindingHash: createHash('sha256').update(idToken).digest('hex'),
  });
}
