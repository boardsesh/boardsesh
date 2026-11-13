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

/** The caller must supply a complete, locked inventory from the selected store. */
export function isAppleOnlyFirstPasswordInventory(
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
      (provider) =>
        provider.provider === 'apple' &&
        provider.subject.length > 0 &&
        provider.userId === userId &&
        provider.generation === generation,
    )
  );
}

/** Confirmation bounds a command; it does not create an authentication age. */
export function firstPasswordDeadline(
  databaseNow: Date,
  sourceExpiresAt: Date,
  bindingExpiresAt: Date,
  browserIntentExpiresAt: Date,
): Date {
  const [now, source, binding, intent] = [databaseNow, sourceExpiresAt, bindingExpiresAt, browserIntentExpiresAt].map(
    (clock) => clock.getTime(),
  );
  if ([now, source, binding, intent].some((clock) => !Number.isSafeInteger(clock) || clock <= 0))
    throw new Error('FIRST_PASSWORD_AUTHORITY_UNAVAILABLE');
  const expiresAt = Math.min(now + FIRST_PASSWORD_CHALLENGE_LIFETIME_MS, source, binding, intent);
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
