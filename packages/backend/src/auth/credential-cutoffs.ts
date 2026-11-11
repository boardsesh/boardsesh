import { readAuthTimeClaim } from '@boardsesh/auth-protocol/auth-time';

/**
 * Whether a presented first-party credential may still be used, decided from
 * its stamps and its climber's cutoff state (BA-04 section 4,
 * docs/better-auth-migration.md "Credential cutoffs"). Pure: every reader and
 * the refresh issuer call this one function, so they cannot disagree.
 */

/**
 * What the admission read knows about a climber whose `users` row exists and
 * whose cutoff row has no `deleted_at`. No entry at all means deleted or missing.
 */
export interface SubjectCutoffState {
  /** `auth_subject_cutoffs.generation`, 0 with no row. */
  readonly generation: number;
  /** `auth_subject_cutoffs.native_generation`, 0 with no row. */
  readonly nativeGeneration: number;
  /**
   * Web login IDs (`authSessionId`) ended one at a time. Nothing writes one
   * until web sign-out does (BA-04 PR 9, table from PR 6), so it is empty today.
   */
  readonly deniedSessionKeys: ReadonlySet<string>;
}

export type PresentedCredential =
  /** The website's NextAuth JWE, its claims as decrypted. */
  | {
      readonly kind: 'web-session';
      readonly generationClaim: unknown;
      readonly sessionKeyClaim: unknown;
      readonly authTimeClaim: unknown;
    }
  /** The app's or watch's JWT, its claims as verified. */
  | {
      readonly kind: 'native-access';
      readonly generationClaim: unknown;
      readonly nativeGenerationClaim: unknown;
      readonly authTimeClaim: unknown;
    }
  /** A `mobile_refresh_tokens` row being rotated. All NULL is a row from before BA-04 PR 1. */
  | {
      readonly kind: 'native-refresh';
      readonly subjectGeneration: number | null;
      readonly nativeGeneration: number | null;
      readonly authenticatedAt: Date | null;
    };

export type CredentialDenialReason =
  /** The account is deleted or missing. Refused before BA-04 PR 2 too, and in every mode. */
  | 'subject-inactive'
  /** A password reset, change, set or deletion moved the generation after this credential was stamped. */
  | 'generation'
  /** An app sign-out moved the native generation. The website has no native stamp, so it is never refused for this. */
  | 'native-generation'
  /** This web login was ended on its own. */
  | 'session-denied'
  /** A stamp that is present but not a whole number of at least 0. Only our signer writes stamps. */
  | 'malformed-stamp';

export interface CredentialDecision {
  /** Null when the credential may be used. */
  readonly denial: CredentialDenialReason | null;
  /**
   * Epoch seconds of the sign-in proof, read from `auth_time` or
   * `authenticated_at` alone. Null is unknown, which is never fresh. A `gen`
   * stamp says nothing about age: a transfer token or watch code mints a
   * credential with `gen` and no `auth_time`.
   */
  readonly authenticatedAt: number | null;
}

/**
 * A credential with no stamp was issued before BA-04 PR 1, while generation 0
 * was the only one, so it stands for 0. Undefined means malformed.
 */
function stampedGeneration(stamp: unknown): number | undefined {
  if (stamp === undefined || stamp === null) return 0;
  return typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp >= 0 ? stamp : undefined;
}

function signInTime(credential: PresentedCredential, nowMs: number): number | null {
  if (credential.kind !== 'native-refresh') return readAuthTimeClaim(credential.authTimeClaim, nowMs);
  return credential.authenticatedAt ? Math.floor(credential.authenticatedAt.getTime() / 1000) : null;
}

function denialFor(
  credential: PresentedCredential,
  subject: SubjectCutoffState | undefined,
): CredentialDenialReason | null {
  if (!subject) return 'subject-inactive';
  const isRefreshRow = credential.kind === 'native-refresh';
  const generation = stampedGeneration(isRefreshRow ? credential.subjectGeneration : credential.generationClaim);
  if (generation === undefined) return 'malformed-stamp';
  if (generation !== subject.generation) return 'generation';
  if (credential.kind === 'web-session') {
    // A phone sign-out ends native credentials only (decision 10), so the web
    // carries no native stamp and is never compared with the native generation.
    const sessionKey = credential.sessionKeyClaim;
    return typeof sessionKey === 'string' && subject.deniedSessionKeys.has(sessionKey) ? 'session-denied' : null;
  }
  const nativeGeneration = stampedGeneration(
    isRefreshRow ? credential.nativeGeneration : credential.nativeGenerationClaim,
  );
  if (nativeGeneration === undefined) return 'malformed-stamp';
  return nativeGeneration === subject.nativeGeneration ? null : 'native-generation';
}

/**
 * The section 4 table. `subject` undefined is a deleted or missing account.
 * Stamps must EQUAL the current generations: generations only rise, so a
 * credential stamped lower predates a cutoff, and one stamped higher was not
 * issued against this database.
 */
export function decideCredential(
  credential: PresentedCredential,
  subject: SubjectCutoffState | undefined,
  nowMs: number,
): CredentialDecision {
  return { denial: denialFor(credential, subject), authenticatedAt: signInTime(credential, nowMs) };
}

export const AUTH_CUTOFF_ENFORCEMENT_ENV = 'AUTH_CUTOFF_ENFORCEMENT';

/**
 * `enforce` refuses every denial. `observe` admits a credential that only a
 * cutoff refuses (generation, native generation, denied login, malformed
 * stamp) and logs it: the behaviour of the build before BA-04 PR 2, for
 * rollback. A deleted account is refused in both.
 */
export type CutoffEnforcement = 'enforce' | 'observe';

/** Strict, for startup and for staged writers: an unknown value is a configuration error. */
export function parseCutoffEnforcement(value: string | undefined): CutoffEnforcement {
  if (value === undefined || value === '' || value === 'enforce') return 'enforce';
  if (value === 'observe') return 'observe';
  throw new Error(`Invalid ${AUTH_CUTOFF_ENFORCEMENT_ENV}`);
}

/** Per request. Anything but exactly `observe` enforces, so a bad value fails closed. */
export function cutoffEnforcement(environment: Readonly<Record<string, string | undefined>>): CutoffEnforcement {
  return environment[AUTH_CUTOFF_ENFORCEMENT_ENV] === 'observe' ? 'observe' : 'enforce';
}

export function isCredentialAdmitted(decision: CredentialDecision, enforcement: CutoffEnforcement): boolean {
  if (decision.denial === null) return true;
  return enforcement === 'observe' && decision.denial !== 'subject-inactive';
}
