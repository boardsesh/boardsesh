import { createHash, timingSafeEqual } from 'node:crypto';

const MIN_ORIGIN_PROOF_SECRET_BYTES = 32;

export type OriginProof = 'unconfigured' | 'proven' | 'unproven';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Verify the secret our zone adds without tying trust to an ingress hop count.
 * Callers supply their service's current and optional rotation secrets. Unset
 * or shorter-than-32-byte secrets do not enable proof verification.
 *
 * Node-only: keep this subpath out of the browser/native package index.
 */
export function verifyOriginProof(
  presented: string | undefined,
  configuredSecrets: readonly (string | undefined)[],
): OriginProof {
  const secrets = configuredSecrets
    .map((secret) => secret?.trim())
    .filter(
      (secret): secret is string => !!secret && Buffer.byteLength(secret, 'utf8') >= MIN_ORIGIN_PROOF_SECRET_BYTES,
    );
  if (secrets.length === 0) return 'unconfigured';
  const normalizedPresented = presented?.trim();
  // Digests have one length, so the comparison time says nothing about a secret.
  // Compare every usable secret, so it does not reveal which rotation matched.
  const presentedDigest = normalizedPresented ? sha256(normalizedPresented) : null;
  const matches = secrets.map((secret) => presentedDigest !== null && timingSafeEqual(presentedDigest, sha256(secret)));
  return matches.includes(true) ? 'proven' : 'unproven';
}
