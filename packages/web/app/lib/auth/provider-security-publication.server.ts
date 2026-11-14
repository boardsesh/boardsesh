import 'server-only';
import { decode, encode, type JWT, type JWTEncodeParams, type JWTOptions } from 'next-auth/jwt';
import {
  webCredentialProofSchema,
  type ProviderSecurityActor,
  type ProviderSecurityReply,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import { sessionCookieNameCandidates } from './secure-cookies';

type Prepared = Extract<ProviderSecurityReply, { operation: 'prepare'; outcome: 'prepared' }>;
export type ProviderSecurityPublicationCursor = Prepared['browserCursor'];
export type ProviderSecurityCandidate = { readonly kind: ProviderSecurityActor['kind']; readonly credential: string };
export interface ProviderSecurityCookiePlan {
  readonly headers: readonly string[];
  readonly candidateCredentialHash: string;
  readonly cursor: ProviderSecurityPublicationCursor;
}
export type PrepareProviderSecurityCookies = (input: {
  readonly candidate: ProviderSecurityCandidate;
  readonly cursor: ProviderSecurityPublicationCursor;
  readonly credentialExpiresAt: string;
  /** Compatibility input only; canonical candidates never reuse framework JWEs. */
  readonly frameworkHeaders: readonly string[];
}) => ProviderSecurityCookiePlan;

const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
export const providerSecuritySessionFamily = (name: string): boolean =>
  sessionCookieNameCandidates().some((base) => name.startsWith(base));
export function providerSecurityCookieName(header: string): string {
  const pair = header.split(';', 1)[0];
  const separator = pair.indexOf('=');
  if (separator <= 0) return refuse();
  return pair.slice(0, separator).trim();
}
export const sameProviderSecurityCursor = (
  left: ProviderSecurityPublicationCursor,
  right: ProviderSecurityPublicationCursor,
): boolean =>
  left.bindingId === right.bindingId &&
  left.version === right.version &&
  Date.parse(left.bindingExpiresAt) === Date.parse(right.bindingExpiresAt);

export function providerSecurityClaimsMatch(claims: JWT, proof: WebCredentialProof): boolean {
  return (
    claims.sub === proof.userId &&
    claims.authSessionId === proof.authSessionId &&
    claims.gen === proof.generation &&
    claims.auth_time ===
      (proof.authenticatedAt === null ? undefined : Math.floor(Date.parse(proof.authenticatedAt) / 1000)) &&
    claims.link_guarded === (proof.linkGuarded ? true : undefined) &&
    claims.legacy_no_sid === (proof.requiresAccountCutoff ? true : undefined)
  );
}
export function samePreparedProviderSecurityProof(before: WebCredentialProof, after: WebCredentialProof): boolean {
  return (
    before.userId === after.userId &&
    before.authSessionId === after.authSessionId &&
    after.generation === before.generation + 1 &&
    before.authenticatedAt === after.authenticatedAt &&
    before.linkGuarded === after.linkGuarded &&
    Boolean(before.requiresAccountCutoff) === Boolean(after.requiresAccountCutoff)
  );
}

/** The qualified primary reader supplies conservative original provenance.
 * Historical signed copies can omit SID/gen and can carry an unguarded age;
 * neither a rolling JTI nor that unqualified age replaces primary admission. */
export function originalLegacyClaimsMatch(claims: JWT, proof: WebCredentialProof): boolean {
  const hasSessionId = claims.authSessionId !== undefined;
  return (
    claims.sub === proof.userId &&
    (claims.gen ?? 0) === proof.generation &&
    (hasSessionId ? claims.authSessionId === proof.authSessionId : proof.requiresAccountCutoff === true) &&
    (claims.legacy_no_sid === undefined || claims.legacy_no_sid === true) &&
    Boolean(proof.requiresAccountCutoff) === (!hasSessionId || claims.legacy_no_sid === true) &&
    (claims.link_guarded === true) === proof.linkGuarded &&
    (proof.authenticatedAt === null ||
      (proof.linkGuarded &&
        typeof claims.auth_time === 'number' &&
        claims.auth_time * 1000 === Date.parse(proof.authenticatedAt)))
  );
}

export function normalizedLegacyCandidate(original: JWT, proof: WebCredentialProof): JWT {
  const claims: JWT = { ...original, authSessionId: proof.authSessionId, gen: proof.generation };
  if (proof.authenticatedAt === null) delete claims.auth_time;
  if (proof.linkGuarded) claims.link_guarded = true;
  else delete claims.link_guarded;
  if (proof.requiresAccountCutoff) claims.legacy_no_sid = true;
  else delete claims.legacy_no_sid;
  return claims;
}

/** Shared actual-credential issuer for callback linking and direct unlinking.
 * Without callback claims, retain the actual JWE's profile and normalize only
 * SID/generation and conservative primary authentication provenance.
 * This does not run signIn, infer freshness, or reconstruct an opaque bearer. */
export async function issuePreparedProviderSecurityCredential(
  input: {
    readonly source: ProviderSecurityCandidate;
    readonly sourceCredentialProof: WebCredentialProof;
    readonly credentialExpiresAt: string;
    readonly prepared: Pick<Prepared, 'credentialProof' | 'credentialExpiresAt' | 'proposedCanonicalToken'>;
    readonly claims?: JWT;
  },
  codec: Pick<JWTEncodeParams, 'secret' | 'salt'> & { readonly encode?: JWTOptions['encode'] },
): Promise<ProviderSecurityCandidate> {
  try {
    const source = Object.freeze({ ...input.source });
    const sourceProof = webCredentialProofSchema.parse(input.sourceCredentialProof);
    const proof = webCredentialProofSchema.parse(input.prepared.credentialProof);
    const deadline = Date.parse(input.credentialExpiresAt);
    const proposal = input.prepared.proposedCanonicalToken;
    const suppliedClaims = input.claims ? { ...input.claims } : undefined;
    const secret = typeof codec.secret === 'string' ? codec.secret : Buffer.from(codec.secret);
    const salt = codec.salt;
    const encoder = codec.encode ?? encode;
    if (
      !samePreparedProviderSecurityProof(sourceProof, proof) ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now() ||
      Date.parse(input.prepared.credentialExpiresAt) !== deadline ||
      !source.credential ||
      Buffer.byteLength(source.credential) > 16_384
    )
      return refuse();
    let credential: string;
    if (source.kind === 'canonical-token') {
      if (
        Buffer.byteLength(source.credential) > 4096 ||
        typeof proposal !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(proposal) ||
        proposal === source.credential ||
        (suppliedClaims && !providerSecurityClaimsMatch(suppliedClaims, proof))
      )
        return refuse();
      credential = proposal;
    } else if (source.kind === 'legacy-jwe') {
      if (proposal !== null) return refuse();
      const original = await decode({ token: source.credential, secret, salt });
      const seconds = deadline / 1000;
      if (
        !original ||
        !Number.isSafeInteger(seconds) ||
        original.exp !== seconds ||
        !originalLegacyClaimsMatch(original, sourceProof)
      )
        return refuse();
      const claims = suppliedClaims ?? normalizedLegacyCandidate(original, proof);
      if (!providerSecurityClaimsMatch(claims, proof)) return refuse();
      const remaining = seconds - Math.floor(Date.now() / 1000);
      if (remaining <= 0) return refuse();
      credential = await encoder({ token: claims, secret, salt, maxAge: remaining });
      const actual = await decode({ token: credential, secret, salt });
      if (!actual || actual.exp !== seconds || !providerSecurityClaimsMatch(actual, proof)) return refuse();
    } else return refuse();
    if (!credential || Buffer.byteLength(credential) > 16_384 || Date.now() >= deadline) return refuse();
    return Object.freeze({ kind: source.kind, credential });
  } catch {
    return refuse();
  }
}

/** Synchronous publication preflight. The body must already be fully buffered;
 * no response construction or cookie-capacity work remains after finalization. */
export function prepareProviderSecurityPublicationResponse(input: {
  readonly candidate: ProviderSecurityCandidate;
  readonly cursor: ProviderSecurityPublicationCursor;
  readonly credentialExpiresAt: string;
  readonly preparationExpiresAt: string;
  readonly frameworkHeaders: readonly string[];
  readonly prepareCookiePublication: PrepareProviderSecurityCookies;
  readonly response: {
    readonly status: number;
    readonly statusText?: string;
    readonly headers: Headers;
    readonly body: Uint8Array<ArrayBuffer> | null;
  };
}): { readonly response: Response; readonly plan: ProviderSecurityCookiePlan } {
  try {
    const credentialExpiresAt = input.credentialExpiresAt;
    const sourceDeadline = Date.parse(credentialExpiresAt);
    const preparationDeadline = Date.parse(input.preparationExpiresAt);
    const body = input.response.body === null ? null : new Uint8Array(input.response.body);
    const status = input.response.status;
    const statusText = input.response.statusText;
    const headers = new Headers(input.response.headers);
    if (
      !Number.isFinite(sourceDeadline) ||
      !Number.isFinite(preparationDeadline) ||
      Date.now() >= sourceDeadline ||
      Date.now() >= preparationDeadline ||
      (body?.byteLength ?? 0) > 65_536
    )
      return refuse();
    const candidate = Object.freeze({ ...input.candidate });
    const cursor = Object.freeze({ ...input.cursor });
    if (
      !/^[a-f0-9]{64}$/.test(cursor.bindingId) ||
      !Number.isSafeInteger(cursor.version) ||
      cursor.version < 1 ||
      cursor.version > 2_147_483_647 ||
      !Number.isFinite(Date.parse(cursor.bindingExpiresAt)) ||
      Date.parse(cursor.bindingExpiresAt) <= Date.now() ||
      (candidate.kind !== 'legacy-jwe' && candidate.kind !== 'canonical-token') ||
      !candidate.credential ||
      Buffer.byteLength(candidate.credential) > 16_384
    )
      return refuse();
    const plan = input.prepareCookiePublication({
      candidate,
      cursor,
      credentialExpiresAt,
      frameworkHeaders: Object.freeze([...input.frameworkHeaders]),
    });
    if (
      !sameProviderSecurityCursor(plan.cursor, cursor) ||
      plan.candidateCredentialHash !== providerCandidateCredentialHash(candidate) ||
      plan.headers.length === 0 ||
      plan.headers.length > 32
    )
      return refuse();
    for (const header of headers.getSetCookie())
      if (
        providerSecuritySessionFamily(providerSecurityCookieName(header)) ||
        providerSecurityCookieName(header).startsWith('__Host-boardsesh.browser-binding')
      )
        return refuse();
    for (const header of plan.headers) {
      if (
        /[\r\n]/.test(header) ||
        Buffer.byteLength(header) > 4096 ||
        providerSecurityCookieName(header).startsWith('__Host-boardsesh.browser-binding')
      )
        return refuse();
      headers.append('Set-Cookie', header);
    }
    headers.delete('Content-Length');
    headers.set('Cache-Control', 'private, no-store');
    let headerBytes = 0;
    for (const [name, content] of headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(content) + 4;
    if (
      headerBytes > 32_768 ||
      headers.getSetCookie().length > 32 ||
      Date.now() >= sourceDeadline ||
      Date.now() >= preparationDeadline
    )
      return refuse();
    const captured = Object.freeze({
      ...plan,
      cursor: Object.freeze({ ...plan.cursor }),
      headers: Object.freeze([...plan.headers]),
    });
    return Object.freeze({
      plan: captured,
      response: new Response(body, { status, statusText, headers }),
    });
  } catch {
    return refuse();
  }
}
