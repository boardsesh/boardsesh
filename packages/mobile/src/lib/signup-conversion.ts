import { Platform } from 'react-native';
import {
  loginProviderProperties,
  parseAccountCreationReceipt,
  SHARED_EVENTS,
  type AccountCreationReceipt,
} from '@boardsesh/analytics';
import { capture, getAnalyticsIdentity, setPersonProperties } from './analytics';
import { createConsentBoundAnalyticsRunner } from './consent-bound-analytics';
import { getPreference, setPreference } from './preference-store';
import { getVerifiedAuthResult } from './verified-auth-result';
import { getConsentSnapshot, subscribeConsent } from './consent-state';
import { isAnalyticsGranted } from '@boardsesh/consent';

const pending = new Set<string>();
const published = new Set<string>();

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
  if (!validated?.accountCreated || pending.has(validated.userId) || published.has(validated.userId)) return;
  const captureWhenReady = createConsentBoundAnalyticsRunner({
    accountId: validated.userId,
    ready: () =>
      getVerifiedAuthResult()?.userId === validated.userId && getAnalyticsIdentity()?.distinctId === validated.userId,
  });
  pending.add(validated.userId);
  const preferenceKey = `signupConversion:${validated.userId}`;
  void getPreference<unknown>(preferenceKey)
    .then((storedTimestamp) => {
      if (storedTimestamp === validated.createdAt) {
        published.add(validated.userId);
        return;
      }
      captureWhenReady(() => {
        if (published.has(validated.userId) || getAnalyticsIdentity()?.distinctId !== validated.userId) return;
        const authMethod = validated.provider === 'email' ? 'credentials' : validated.provider;
        const forwarded = capture(
          SHARED_EVENTS.SignupCompleted,
          { ...loginProviderProperties(authMethod), flow: Platform.OS === 'web' ? 'web' : 'native' },
          { timestamp: new Date(validated.createdAt), uuid: validated.userId },
        );
        if (!forwarded) return;
        published.add(validated.userId);
        setPersonProperties(undefined, { signup_at: validated.createdAt, signup_auth_method: authMethod });
        // The stable event UUID prevents duplication if persistence fails or the app exits here.
        void setPreference(preferenceKey, validated.createdAt).catch(() => {});
      });
    })
    .catch(() => {
      // A failed read can retry after the next successful auth; it must not invent a marker.
    })
    .finally(() => pending.delete(validated.userId));
}
