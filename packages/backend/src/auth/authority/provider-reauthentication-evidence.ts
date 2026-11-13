import { createHash } from 'node:crypto';
import { compare } from 'bcryptjs';
import type { ProviderSecurityProvider } from '@boardsesh/auth-protocol';
import type { IdentityPasswordSnapshot } from './identity-authority';
import type { IdentityAuthorityReceipt } from './router';
import {
  googleReauthenticationDeadline,
  isUsableProviderPassword,
  PROVIDER_REAUTHENTICATION_LIFETIME_MS,
  type ProviderSecurityMethodsConfiguration,
} from './provider-security-policy';
import { verifyProviderGoogleAuthenticationAssertion } from './provider-google-reauthentication';

/** Captured from an admitted, locked intent before any external verification. */
export interface ProviderReauthenticationBinding {
  readonly intentHash: string;
  readonly actorCredentialHash: string;
  readonly userId: string;
  readonly actorSessionId: string;
  readonly actorGeneration: number;
  readonly operation: 'link' | 'unlink';
  readonly provider: ProviderSecurityProvider;
  /** Unlink has a fixed subject at creation. A link's target is bound exactly once by preparation. */
  readonly unlinkSubject: string | null;
  readonly authority: IdentityAuthorityReceipt;
  readonly expiresAt: Date;
}

declare const providerReauthenticationEvidenceBrand: unique symbol;
export interface ProviderReauthenticationEvidence {
  readonly [providerReauthenticationEvidenceBrand]: true;
}
interface EvidenceRecord {
  readonly binding: ProviderReauthenticationBinding;
  readonly method: 'password' | 'google-auth-time';
  readonly proofBindingHash: string;
  readonly providerSubject: string | null;
  readonly authenticatedAt: Date;
  readonly proofExpiresAt: Date;
  readonly expiresAt: Date;
  readonly password: IdentityPasswordSnapshot | null;
}
const verifiedEvidence = new WeakMap<ProviderReauthenticationEvidence, EvidenceRecord>();
function finitePositiveDate(candidate: Date): boolean {
  return Number.isSafeInteger(candidate.getTime()) && candidate.getTime() > 0;
}
function validBinding(binding: ProviderReauthenticationBinding): boolean {
  return (
    /^[a-f0-9]{64}$/.test(binding.intentHash) &&
    /^[a-f0-9]{64}$/.test(binding.actorCredentialHash) &&
    Boolean(binding.userId) &&
    Boolean(binding.actorSessionId) &&
    Number.isSafeInteger(binding.actorGeneration) &&
    binding.actorGeneration >= 0 &&
    ['link', 'unlink'].includes(binding.operation) &&
    ['google', 'apple'].includes(binding.provider) &&
    (binding.operation === 'unlink' ? Boolean(binding.unlinkSubject) : binding.unlinkSubject === null) &&
    Boolean(binding.authority.projectionId) &&
    Boolean(binding.authority.normalizerVersion) &&
    ['current-store', 'better-auth'].includes(binding.authority.authority) &&
    Number.isSafeInteger(binding.authority.epoch) &&
    binding.authority.epoch > 0 &&
    finitePositiveDate(binding.expiresAt)
  );
}

function captureBinding(binding: ProviderReauthenticationBinding): ProviderReauthenticationBinding {
  return Object.freeze({
    ...binding,
    authority: Object.freeze({ ...binding.authority }),
    expiresAt: new Date(binding.expiresAt),
  });
}
function bindingHash(binding: ProviderReauthenticationBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'provider-reauthentication-binding-v1',
        binding.intentHash,
        binding.actorCredentialHash,
        binding.userId,
        binding.actorSessionId,
        binding.actorGeneration,
        binding.operation,
        binding.provider,
        binding.unlinkSubject,
        binding.authority.projectionId,
        binding.authority.normalizerVersion,
        binding.authority.authority,
        binding.authority.epoch,
        binding.expiresAt.getTime(),
      ]),
    )
    .digest('hex');
}
function mint(record: EvidenceRecord): ProviderReauthenticationEvidence {
  const evidence = Object.freeze({}) as ProviderReauthenticationEvidence;
  verifiedEvidence.set(evidence, record);
  return evidence;
}
export function providerPasswordProofBindingHash(password: IdentityPasswordSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-password-proof-v1', password.userId, password.generation, password.passwordHash]))
    .digest('hex');
}

/**
 * The database clock is captured BEFORE bcrypt. Work runs with no transaction
 * held; delayed verification can only shorten the five-minute authorization.
 * The receipt writer must re-read the exact selected hash under the user lock.
 */
export async function verifyProviderPasswordReauthentication(input: {
  readonly binding: ProviderReauthenticationBinding;
  readonly password: IdentityPasswordSnapshot;
  readonly databaseStartedAt: Date;
  readonly submittedPassword: string;
}): Promise<ProviderReauthenticationEvidence | null> {
  const binding = captureBinding(input.binding);
  const password = Object.freeze({ ...input.password });
  const authenticatedAt = new Date(input.databaseStartedAt);
  const submittedPassword = input.submittedPassword;
  if (
    !validBinding(binding) ||
    !isUsableProviderPassword(password, binding.userId, binding.actorGeneration) ||
    !submittedPassword ||
    submittedPassword.length > 16_384 ||
    !finitePositiveDate(authenticatedAt) ||
    authenticatedAt.getTime() >= binding.expiresAt.getTime()
  )
    return null;
  if (!(await compare(submittedPassword, password.passwordHash))) return null;
  const expiresAt = new Date(
    Math.min(authenticatedAt.getTime() + PROVIDER_REAUTHENTICATION_LIFETIME_MS, binding.expiresAt.getTime()),
  );
  return mint(
    Object.freeze({
      binding,
      method: 'password',
      proofBindingHash: providerPasswordProofBindingHash(password),
      providerSubject: null,
      authenticatedAt,
      proofExpiresAt: new Date(binding.expiresAt),
      expiresAt,
      password,
    }),
  );
}

/** A verified signed auth_time is kept separate from iat and the original requesting session's age. */
export async function verifyProviderGoogleReauthentication(input: {
  readonly binding: ProviderReauthenticationBinding;
  readonly configuration: ProviderSecurityMethodsConfiguration;
  readonly databaseStartedAt: Date;
  readonly idToken: string;
  readonly nonce: string;
}): Promise<ProviderReauthenticationEvidence | null> {
  const binding = captureBinding(input.binding);
  const configuration = Object.freeze({
    ...input.configuration,
    configuredProviders: Object.freeze([...input.configuration.configuredProviders]),
  });
  const databaseStartedAt = new Date(input.databaseStartedAt);
  const idToken = input.idToken;
  const nonce = input.nonce;
  if (
    !validBinding(binding) ||
    !finitePositiveDate(databaseStartedAt) ||
    databaseStartedAt.getTime() >= binding.expiresAt.getTime()
  )
    return null;
  const assertion = await verifyProviderGoogleAuthenticationAssertion(configuration, { idToken, nonce });
  if (!assertion) return null;
  const expiresAt = googleReauthenticationDeadline(
    assertion.authenticatedAt,
    assertion.expiresAt,
    databaseStartedAt,
    binding.expiresAt,
  );
  if (!expiresAt) return null;
  return mint(
    Object.freeze({
      binding,
      method: 'google-auth-time',
      proofBindingHash: assertion.proofBindingHash,
      providerSubject: assertion.subject,
      authenticatedAt: new Date(assertion.authenticatedAt * 1000),
      proofExpiresAt: new Date(assertion.expiresAt * 1000),
      expiresAt,
      password: null,
    }),
  );
}

/**
 * Only the real verifier can mint evidence. Copying/serializing an object or
 * changing actor/operation/authority cannot establish reauthentication. This
 * does not replace primary actor, hash or provider-owner admission.
 */
export function requireProviderReauthenticationEvidence(
  evidence: ProviderReauthenticationEvidence,
  currentBinding: ProviderReauthenticationBinding,
  databaseNow: Date,
): Readonly<Omit<EvidenceRecord, 'binding'>> {
  const record = typeof evidence === 'object' && evidence !== null ? verifiedEvidence.get(evidence) : undefined;
  if (
    !record ||
    !validBinding(record.binding) ||
    !validBinding(currentBinding) ||
    !finitePositiveDate(record.authenticatedAt) ||
    !finitePositiveDate(record.proofExpiresAt) ||
    !finitePositiveDate(record.expiresAt) ||
    !finitePositiveDate(databaseNow) ||
    record.expiresAt.getTime() > record.authenticatedAt.getTime() + PROVIDER_REAUTHENTICATION_LIFETIME_MS ||
    record.expiresAt.getTime() > record.proofExpiresAt.getTime() ||
    record.expiresAt.getTime() > record.binding.expiresAt.getTime() ||
    record.expiresAt.getTime() <= record.authenticatedAt.getTime() ||
    bindingHash(record.binding) !== bindingHash(currentBinding) ||
    record.authenticatedAt.getTime() > databaseNow.getTime() ||
    record.expiresAt.getTime() <= databaseNow.getTime() ||
    record.proofExpiresAt.getTime() <= databaseNow.getTime()
  )
    throw new Error('PROVIDER_REAUTHENTICATION_EVIDENCE_INVALID');
  return Object.freeze({
    method: record.method,
    proofBindingHash: record.proofBindingHash,
    providerSubject: record.providerSubject,
    authenticatedAt: new Date(record.authenticatedAt),
    proofExpiresAt: new Date(record.proofExpiresAt),
    expiresAt: new Date(record.expiresAt),
    password: record.password ? Object.freeze({ ...record.password }) : null,
  });
}
