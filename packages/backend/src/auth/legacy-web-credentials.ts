import { createHash } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { jwtDecrypt } from 'jose';
import {
  AUTH_TIME_CLOCK_SKEW_SECONDS,
  isLinkGuardedSignIn,
  readAuthTimeClaim,
} from '@boardsesh/auth-protocol/auth-time';

const SESSION_COOKIE_NAMES = ['__Secure-next-auth.session-token', 'next-auth.session-token'] as const;
const MAX_COOKIE_HEADER_LENGTH = 128 * 1024;
const MAX_CREDENTIAL_LENGTH = 64 * 1024;
const MAX_COOKIE_CHUNKS = 64;
const MAX_SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// NextAuth computes iat and exp from separate clock reads. A second boundary
// or bounded process pause can make a genuine signed span exceed maxAge.
const ENCODER_CLOCK_READ_ALLOWANCE_SECONDS = 60;
// Match the backend's installed validateNextAuthToken transport. NextAuth's
// browser decoder uses 15 seconds instead; this is deliberately explicit.
export const LEGACY_WEB_CLOCK_TOLERANCE_SECONDS = 60;

export interface VerifiedLegacyWebCredential {
  readonly kind: 'nextauth-v4-jwe';
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly validUntil: Date;
  readonly clockToleranceSeconds: typeof LEGACY_WEB_CLOCK_TOLERANCE_SECONDS;
  /**
   * When the climber signed in to produce this login, from the `auth_time` claim
   * the web jwt callback writes on a completed sign-in (and never on a rotation
   * or a native transfer). Null means unknown: a cookie from before the claim, or
   * a value that is not a whole positive number of seconds, sits further ahead
   * than clock skew explains, or postdates the cookie's own issue time.
   */
  readonly originalAuthenticatedAt: Date | null;
  /**
   * The sign-in was made while the web guarded OAuth account links, so its
   * `auth_time` cannot have been bought by linking a provider into an old
   * session (`link_guarded: true`, written only beside `auth_time`).
   */
  readonly linkGuarded: boolean;
  readonly authSessionId: string | null;
  readonly lineageId: string;
  readonly credentialFingerprint: string;
  readonly requiresAccountCutoff: boolean;
  readonly cookieNames: readonly string[];
}

function fingerprint(material: string): string {
  return createHash('sha256').update(material).digest('hex');
}

/**
 * The sign-in time the cookie claims. The rolling iat and jti never prove it.
 * A sign-in cannot postdate the cookie it produced, so a claim past the issue
 * time (beyond skew) is as unknown as a malformed one.
 */
function signedInAt(claim: unknown, issuedAtSeconds: number, currentTime: Date): Date | null {
  const authTime = readAuthTimeClaim(claim, currentTime.getTime());
  if (authTime === null || authTime > issuedAtSeconds + AUTH_TIME_CLOCK_SKEW_SECONDS) return null;
  return new Date(authTime * 1000);
}

/**
 * Exact installed NextAuth 4.24.15 encoding, using only its legacy verification
 * key. There is intentionally no framework dependency or successful-token cache.
 */
export async function verifyLegacyNextAuthJwe(
  credential: string,
  verificationSecret: string,
  currentTime = new Date(),
): Promise<VerifiedLegacyWebCredential | null> {
  if (
    !verificationSecret ||
    !credential ||
    credential.length > MAX_CREDENTIAL_LENGTH ||
    credential.split('.').length !== 5 ||
    !Number.isFinite(currentTime.getTime())
  )
    return null;

  try {
    // Cookie names are not a salt in NextAuth v4. Do not import Auth.js v5's
    // different key context or broaden supported encryption algorithms.
    const encryptionKey = await hkdf(
      'sha256',
      new TextEncoder().encode(verificationSecret),
      '',
      'NextAuth.js Generated Encryption Key',
      32,
    );
    const { payload } = await jwtDecrypt(credential, encryptionKey, {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
      requiredClaims: ['sub', 'iat', 'exp'],
      currentDate: currentTime,
      clockTolerance: LEGACY_WEB_CLOCK_TOLERANCE_SECONDS,
    });
    const userId = payload.sub;
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    if (
      typeof userId !== 'string' ||
      userId.trim().length === 0 ||
      userId.length > 256 ||
      typeof issuedAt !== 'number' ||
      !Number.isInteger(issuedAt) ||
      issuedAt < 0 ||
      typeof expiresAt !== 'number' ||
      !Number.isInteger(expiresAt) ||
      issuedAt * 1000 > currentTime.getTime() + LEGACY_WEB_CLOCK_TOLERANCE_SECONDS * 1000 ||
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > MAX_SESSION_LIFETIME_SECONDS + ENCODER_CLOCK_READ_ALLOWANCE_SECONDS ||
      // The installed session encoder sets none of these purpose/audience
      // claims. A separately labelled credential must not become a session.
      payload.iss !== undefined ||
      payload.aud !== undefined ||
      payload.purpose !== undefined ||
      payload.token_use !== undefined
    )
      return null;

    const claimedSessionId = payload.authSessionId;
    if (
      claimedSessionId !== undefined &&
      (typeof claimedSessionId !== 'string' || claimedSessionId.trim().length === 0 || claimedSessionId.length > 256)
    )
      return null;
    const authSessionId = typeof claimedSessionId === 'string' ? claimedSessionId : null;
    const credentialFingerprint = fingerprint(credential);
    return {
      kind: 'nextauth-v4-jwe',
      userId,
      issuedAt: new Date(issuedAt * 1000),
      expiresAt: new Date(expiresAt * 1000),
      // Keep the signed expiry distinct from the accepted transport grace.
      // A later bridge must also subtract the skew allowance from issuedAt
      // when comparing user cutoffs; an ahead-clock token is not a new login.
      validUntil: new Date((expiresAt + LEGACY_WEB_CLOCK_TOLERANCE_SECONDS) * 1000),
      clockToleranceSeconds: LEGACY_WEB_CLOCK_TOLERANCE_SECONDS,
      // Only a cookie written by a sign-in carries auth_time (#6981, F5). The
      // attribution timestamp in nativeOAuthCreationProof is not one.
      originalAuthenticatedAt: signedInAt(payload.auth_time, issuedAt, currentTime),
      linkGuarded: isLinkGuardedSignIn(payload),
      authSessionId,
      lineageId: `${authSessionId ? 'session' : 'credential'}:${fingerprint(
        JSON.stringify(['nextauth-v4', userId, authSessionId ?? credentialFingerprint]),
      )}`,
      credentialFingerprint,
      requiresAccountCutoff: authSessionId === null,
      cookieNames: [],
    };
  } catch {
    // Crypto failures may include credential bytes. No tokens or claims enter logs.
    return null;
  }
}

type CookieCredential = { credential: string; cookieNames: string[] };

function cookieCredentials(cookieHeader: string): CookieCredential[] | null {
  if (cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) return null;
  const cookies = new Map<string, string>();
  for (const member of cookieHeader.split(';')) {
    const separator = member.indexOf('=');
    if (separator < 0) continue;
    const name = member.slice(0, separator).trim();
    if (!SESSION_COOKIE_NAMES.some((baseName) => name === baseName || name.startsWith(`${baseName}.`))) continue;
    let content: string;
    try {
      content = decodeURIComponent(member.slice(separator + 1).trim());
    } catch {
      return null;
    }
    const existing = cookies.get(name);
    if (existing !== undefined && existing !== content) return null;
    cookies.set(name, content);
  }

  const candidates: CookieCredential[] = [];
  for (const baseName of SESSION_COOKIE_NAMES) {
    const base = cookies.get(baseName);
    const chunks: { name: string; index: number; content: string }[] = [];
    for (const [name, content] of cookies) {
      if (!name.startsWith(`${baseName}.`)) continue;
      const suffix = name.slice(baseName.length + 1);
      if (!/^(0|[1-9]\d*)$/.test(suffix)) return null;
      const index = Number(suffix);
      if (!Number.isSafeInteger(index) || index >= MAX_COOKIE_CHUNKS) return null;
      chunks.push({ name, index, content });
    }
    if (base !== undefined && chunks.length > 0) return null;
    if (base !== undefined) {
      if (!base) return null;
      candidates.push({ credential: base, cookieNames: [baseName] });
    } else if (chunks.length > 0) {
      chunks.sort((firstChunk, secondChunk) => firstChunk.index - secondChunk.index);
      if (chunks.some((chunk, index) => chunk.index !== index || chunk.content.length === 0)) return null;
      candidates.push({
        credential: chunks.map((chunk) => chunk.content).join(''),
        cookieNames: chunks.map((chunk) => chunk.name),
      });
    }
  }
  return candidates;
}

/** The earliest sign-in any accepted copy claims, and unknown if any copy has none. */
function combinedSignIn(proofs: readonly VerifiedLegacyWebCredential[]): Date | null {
  let earliest: Date | null = null;
  for (const proof of proofs) {
    if (!proof.originalAuthenticatedAt) return null;
    if (!earliest || proof.originalAuthenticatedAt < earliest) earliest = proof.originalAuthenticatedAt;
  }
  return earliest;
}

/**
 * Accept both historical names and contiguous NextAuth chunks. Conflicting
 * identities fail closed rather than selecting whichever cookie arrived first.
 * Invalid stale alternate credentials do not override a valid session. Equal
 * credentials, or rotations with the same proven user/session lineage,
 * are safe to combine; their issuance, expiry and sign-in bounds remain
 * conservative.
 */
export async function verifyLegacyWebCookie(
  cookieHeader: string | null,
  verificationSecret: string,
  currentTime = new Date(),
): Promise<VerifiedLegacyWebCredential | null> {
  if (cookieHeader === null) return null;
  const candidates = cookieCredentials(cookieHeader);
  if (!candidates?.length) return null;
  const verified = await Promise.all(
    candidates.map(async (candidate) => {
      const proof = await verifyLegacyNextAuthJwe(candidate.credential, verificationSecret, currentTime);
      return proof ? { ...proof, cookieNames: candidate.cookieNames } : null;
    }),
  );
  const proofs = verified.filter((proof) => proof !== null);
  if (proofs.length === 0) return null;
  const first = proofs[0];
  if (proofs.some((proof) => proof.userId !== first.userId || proof.lineageId !== first.lineageId)) return null;
  const fingerprints = [...new Set(proofs.map((proof) => proof.credentialFingerprint))].sort();
  return {
    ...first,
    issuedAt: new Date(Math.min(...proofs.map((proof) => proof.issuedAt.getTime()))),
    expiresAt: new Date(Math.min(...proofs.map((proof) => proof.expiresAt.getTime()))),
    validUntil: new Date(Math.min(...proofs.map((proof) => proof.validUntil.getTime()))),
    originalAuthenticatedAt: combinedSignIn(proofs),
    // Guarded only if every accepted copy says so.
    linkGuarded: proofs.every((proof) => proof.linkGuarded),
    credentialFingerprint: fingerprints.length === 1 ? fingerprints[0] : fingerprint(JSON.stringify(fingerprints)),
    // Include stale recognized alternates so a successful handoff can clear
    // their exact chunk names, without trusting any of their identity claims.
    cookieNames: candidates.flatMap((candidate) => candidate.cookieNames),
  };
}
