import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FirstPartyCredential } from './session-reader';

export const providerCandidateCredentialSchema = z
  .object({ kind: z.enum(['legacy-jwe', 'canonical-token']), credential: z.string().min(1).max(65_536) })
  .strict();
export type ProviderCandidateCredential = z.infer<typeof providerCandidateCredentialSchema>;

export function providerCredentialHash(credential: ProviderCandidateCredential): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-security-credential-v1', credential.kind, credential.credential]))
    .digest('hex');
}

export function presentedProviderCredential(credential: FirstPartyCredential): ProviderCandidateCredential {
  return {
    kind: credential.kind,
    credential: credential.kind === 'canonical-token' ? credential.token : credential.credential,
  };
}
