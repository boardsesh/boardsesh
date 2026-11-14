import 'server-only';
import { decode, encode, type JWTEncodeParams, type JWTOptions } from 'next-auth/jwt';
import { webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import {
  browserSourceCredentialSchema,
  type BrowserSourceCredential,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  browserRenewalPreparationSchema,
  type BrowserRenewalPreparation,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { browserRenewalSourceHash } from './browser-renewal-command-client.server';
import {
  originalLegacyClaimsMatch,
  normalizedLegacyCandidate,
  providerSecurityClaimsMatch,
} from './provider-security-publication.server';

/** Actual credential issuance only. Renewal retains the admitted original age,
 * SID and generation; a new JWE iat/jti never supplies fresh authentication. */
export async function issuePreparedBrowserRenewalCredential(
  input: {
    readonly source: BrowserSourceCredential;
    readonly sourceCredentialProof: WebCredentialProof;
    readonly sourceExpiresAt: string;
    readonly preparation: BrowserRenewalPreparation;
  },
  codec: Pick<JWTEncodeParams, 'secret' | 'salt'> & { readonly encode?: JWTOptions['encode'] },
): Promise<Readonly<BrowserSourceCredential>> {
  try {
    const source = browserSourceCredentialSchema.parse(input.source);
    const sourceProof = webCredentialProofSchema.parse(input.sourceCredentialProof);
    const preparation = browserRenewalPreparationSchema.parse(input.preparation);
    const sourceDeadline = Date.parse(input.sourceExpiresAt);
    const targetSeconds = Date.parse(preparation.targetExpiresAt) / 1_000;
    const preparationDeadline = Date.parse(preparation.expiresAt);
    const alive = () => Date.now() < Math.min(sourceDeadline, preparationDeadline);
    if (
      !Number.isFinite(sourceDeadline) ||
      sourceDeadline !== Date.parse(preparation.sourceExpiresAt) ||
      preparation.credentialKind !== source.kind ||
      preparation.sourceCredentialHash !== browserRenewalSourceHash(source) ||
      JSON.stringify(preparation.sourceCredentialProof) !== JSON.stringify(sourceProof) ||
      !Number.isSafeInteger(targetSeconds) ||
      !alive()
    )
      throw new AuthBackendUnavailableError();
    if (source.kind === 'canonical-token') return Object.freeze({ ...source });
    const secret = typeof codec.secret === 'string' ? codec.secret : Buffer.from(codec.secret);
    const salt = codec.salt;
    const encoder = codec.encode ?? encode;
    const original = await decode({ secret, salt, token: source.credential });
    if (
      !original ||
      original.exp !== sourceDeadline / 1_000 ||
      !originalLegacyClaimsMatch(original, sourceProof) ||
      !alive()
    )
      throw new AuthBackendUnavailableError();
    const claims = normalizedLegacyCandidate(original, sourceProof);
    if (!providerSecurityClaimsMatch(claims, sourceProof)) throw new AuthBackendUnavailableError();
    const remaining = targetSeconds - Math.floor(Date.now() / 1_000);
    if (remaining <= 0) throw new AuthBackendUnavailableError();
    const credential = await encoder({ token: claims, secret, salt, maxAge: remaining });
    const candidate = browserSourceCredentialSchema.parse({ kind: 'legacy-jwe', credential });
    const actual = await decode({ secret, salt, token: credential });
    if (!actual || actual.exp !== targetSeconds || !providerSecurityClaimsMatch(actual, sourceProof) || !alive())
      throw new AuthBackendUnavailableError();
    return Object.freeze(candidate);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}
