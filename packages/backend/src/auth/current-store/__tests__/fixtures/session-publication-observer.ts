import { createHash } from 'node:crypto';
import type { NextAuthOptions } from '../../../../../../web/node_modules/next-auth';
import type { JWT, decode, encode } from '../../../../../../web/node_modules/next-auth/jwt';

interface TokenObservation {
  tokenDigest: string | null;
  userId: string | null;
  authSessionId: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
}

function tokenObservation(rawToken: string | undefined, claims: JWT | null): TokenObservation {
  return {
    tokenDigest: rawToken ? createHash('sha256').update(rawToken).digest('hex') : null,
    userId: typeof claims?.sub === 'string' ? claims.sub : null,
    authSessionId: typeof claims?.authSessionId === 'string' ? claims.authSessionId : null,
    issuedAt: typeof claims?.iat === 'number' ? claims.iat : null,
    expiresAt: typeof claims?.exp === 'number' ? claims.exp : null,
  };
}

/** Observe the real public codec in this child only; encoding is not publication. */
export function observeSessionPublication(
  options: NextAuthOptions,
  publicJwt: { encode: typeof encode; decode: typeof decode },
) {
  const originalEncode = options.jwt?.encode ?? publicJwt.encode;
  const originalDecode = options.jwt?.decode ?? publicJwt.decode;
  const encodes: (TokenObservation & { maxAge: number | null; observationFailed: boolean })[] = [];
  const decodes: (TokenObservation & { failed: boolean })[] = [];
  options.jwt = {
    ...options.jwt,
    async encode(parameters) {
      const rawToken = await originalEncode(parameters);
      // Decode for observation through the unwrapped public codec. This must not
      // count as a reader or replace the public encoder's actual signed lifetime.
      let claims: JWT | null = null;
      let observationFailed = false;
      try {
        claims = await publicJwt.decode({ token: rawToken, secret: parameters.secret, salt: parameters.salt });
      } catch {
        observationFailed = true;
      }
      encodes.push({
        ...tokenObservation(rawToken, claims),
        maxAge: parameters.maxAge ?? null,
        observationFailed,
      });
      return rawToken;
    },
    async decode(parameters) {
      try {
        const claims = await originalDecode(parameters);
        decodes.push({ ...tokenObservation(parameters.token, claims), failed: false });
        return claims;
      } catch (error) {
        decodes.push({ ...tokenObservation(parameters.token, null), failed: true });
        throw error;
      }
    },
  };
  return {
    snapshot: () => ({
      encodes: encodes.map((observation) => ({ ...observation })),
      decodes: decodes.map((observation) => ({ ...observation })),
    }),
  };
}
