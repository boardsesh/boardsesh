import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeAccountEmail } from '../normalize-email';
import type { IdentityAuthorityQualification, IdentityAuthorityReceipt } from './router';
import type { ProviderIdentitySnapshot } from './identity-authority';

export const FIRST_PASSWORD_CHALLENGE_LIFETIME_MS = 300_000;
export const FIRST_PASSWORD_RECOVERY_LIFETIME_MS = 120_000;

export interface FirstPasswordRuntime {
  readonly qualification: IdentityAuthorityQualification;
  readonly legacySecret: string | undefined;
  /** Captured by the backend from its private RPC configuration, never a command. */
  readonly emailBindingKey: string;
}

export function captureFirstPasswordRuntime(input: FirstPasswordRuntime): FirstPasswordRuntime {
  const { emailBindingKey, legacySecret } = input;
  const qualification = Object.freeze({ ...input.qualification });
  if (typeof emailBindingKey !== 'string' || Buffer.byteLength(emailBindingKey, 'utf8') < 32)
    throw new Error('FIRST_PASSWORD_AUTHORITY_UNAVAILABLE');
  return Object.freeze({ qualification, legacySecret, emailBindingKey });
}

/** A deleted address is not left behind as a dictionary-testable plain digest. */
export function firstPasswordEmailBinding(
  runtime: FirstPasswordRuntime,
  authority: IdentityAuthorityReceipt,
  userId: string,
  currentEmail: string,
): string {
  const frame = JSON.stringify([
    'boardsesh.auth.email-binding.v1',
    'first-password',
    authority.projectionId,
    authority.normalizerVersion,
    userId,
    normalizeAccountEmail(currentEmail),
  ]);
  return createHmac('sha256', runtime.emailBindingKey).update(frame, 'utf8').digest('hex');
}

/**
 * Whether an account may set a first password by emailed confirmation
 * (decision of 2026-11-18 on #7596, widening the Apple-only rule of
 * 2026-11-13): at least one identity, every row this user's at this
 * generation with a subject, and at least one Google or Apple identity. A
 * Facebook row beside one of those does not block; a Facebook-only account
 * stays not eligible. The caller supplies a complete, locked inventory from
 * the selected store; a password is refused separately (`already_set`).
 */
export function isFirstPasswordInventory(
  providers: readonly ProviderIdentitySnapshot[],
  userId: string,
  generation: number,
): boolean {
  return (
    Number.isSafeInteger(generation) &&
    generation >= 0 &&
    generation < 2_147_483_647 &&
    providers.length > 0 &&
    providers.every(
      (provider) => provider.subject.length > 0 && provider.userId === userId && provider.generation === generation,
    ) &&
    providers.some((provider) => provider.provider === 'google' || provider.provider === 'apple')
  );
}

/**
 * The durable cap on first-password email (decision of 2026-11-18): an
 * account gets at most this many challenges, counted from `issued_at`, in each
 * window. The per-process limit of 3 a minute stays in front of it.
 */
export const FIRST_PASSWORD_CHALLENGES_PER_HOUR = 5;
export const FIRST_PASSWORD_CHALLENGES_PER_DAY = 10;

/** Confirmation bounds a command; it does not create an authentication age. */
export function firstPasswordDeadline(databaseNow: Date, sourceExpiresAt: Date): Date {
  const [now, source] = [databaseNow, sourceExpiresAt].map((clock) => clock.getTime());
  if ([now, source].some((clock) => !Number.isSafeInteger(clock) || clock <= 0))
    throw new Error('FIRST_PASSWORD_AUTHORITY_UNAVAILABLE');
  const expiresAt = Math.min(now + FIRST_PASSWORD_CHALLENGE_LIFETIME_MS, source);
  if (expiresAt <= now) throw new Error('FIRST_PASSWORD_EXPIRED');
  return new Date(expiresAt);
}

export function equalFirstPasswordDigest(left: string, right: string): boolean {
  return (
    /^[a-f0-9]{64}$/.test(left) &&
    /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}
