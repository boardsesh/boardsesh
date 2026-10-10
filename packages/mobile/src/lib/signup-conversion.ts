import { Platform } from 'react-native';
import {
  loginProviderProperties,
  parseAccountCreationReceipt,
  SHARED_EVENTS,
  type AccountCreationReceipt,
} from '@boardsesh/analytics';
import { capture, getAnalyticsIdentity, setPersonProperties } from './analytics';
import { createConsentBoundAnalyticsRunner } from './consent-bound-analytics';
import { getPreference, removePreference, setPreference } from './preference-store';
import { getVerifiedAuthResult } from './verified-auth-result';
import { getConsentSnapshot, subscribeConsent } from './consent-state';
import { isAnalyticsGranted } from '@boardsesh/consent';

const pending = new Set<string>();
const published = new Set<string>();
const forgotten = new Set<string>();
const markerWrites = new Map<string, Promise<void>>();

export type SignupConsentLease = { isCurrent: () => boolean; dispose: () => void };

/** Preserve the choice at auth success through the expected account-resolution hold. */
export function createSignupConsentLease(): SignupConsentLease {
  const origin = getConsentSnapshot();
  let valid = origin.loaded && !origin.killed && isAnalyticsGranted(origin.record);
  const unsubscribe = subscribeConsent(() => {
    const current = getConsentSnapshot();
    if (!current.loaded || current.killed || !isAnalyticsGranted(current.record)) valid = false;
  });
  return { isCurrent: () => valid, dispose: unsubscribe };
}

/** One genuine creation conversion; delayed attribution enriches the person separately. */
export function publishSignupConversion(receipt: AccountCreationReceipt, consentLease?: SignupConsentLease): void {
  if (consentLease && !consentLease.isCurrent()) return;
  const validated = parseAccountCreationReceipt(receipt);
  if (
    !validated?.accountCreated ||
    forgotten.has(validated.userId) ||
    pending.has(validated.userId) ||
    published.has(validated.userId)
  )
    return;
  const captureWhenReady = createConsentBoundAnalyticsRunner({
    accountId: validated.userId,
    ready: () =>
      !forgotten.has(validated.userId) &&
      getVerifiedAuthResult()?.userId === validated.userId &&
      getAnalyticsIdentity()?.distinctId === validated.userId,
  });
  pending.add(validated.userId);
  const preferenceKey = `signupConversion:${validated.userId}`;
  void getPreference<unknown>(preferenceKey)
    .then((storedTimestamp) => {
      if (forgotten.has(validated.userId)) return;
      if (storedTimestamp === validated.createdAt) {
        published.add(validated.userId);
        return;
      }
      captureWhenReady(() => {
        if (
          forgotten.has(validated.userId) ||
          published.has(validated.userId) ||
          getAnalyticsIdentity()?.distinctId !== validated.userId
        )
          return;
        const authMethod = validated.provider === 'email' ? 'credentials' : validated.provider;
        const forwarded = capture(
          SHARED_EVENTS.SignupCompleted,
          { ...loginProviderProperties(authMethod), flow: Platform.OS === 'web' ? 'web' : 'native' },
          { timestamp: new Date(validated.createdAt), uuid: validated.userId },
        );
        if (!forwarded || forgotten.has(validated.userId)) return;
        published.add(validated.userId);
        setPersonProperties(undefined, { signup_at: validated.createdAt, signup_auth_method: authMethod });
        // The stable event UUID prevents duplication if persistence fails or the app exits here.
        if (forgotten.has(validated.userId)) return;
        const write = setPreference(preferenceKey, validated.createdAt).catch(() => {});
        markerWrites.set(validated.userId, write);
        void write.finally(() => {
          if (markerWrites.get(validated.userId) === write) markerWrites.delete(validated.userId);
        });
      });
    })
    .catch(() => {
      // A failed read can retry after the next successful auth; it must not invent a marker.
    })
    .finally(() => pending.delete(validated.userId));
}

/** Remove only a successfully deleted account's marker after its last write settles. */
export async function forgetSignupConversion(userId: string): Promise<void> {
  forgotten.add(userId);
  pending.delete(userId);
  published.delete(userId);
  await markerWrites.get(userId);
  await removePreference(`signupConversion:${userId}`);
}
