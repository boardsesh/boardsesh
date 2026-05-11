/* oxlint-disable no-restricted-globals -- tests cover PostHog alias localStorage durability */

import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { CONSENT_COOKIE, CONSENT_POLICY_VERSION } from '../consent';
import { hasRecordedPosthogAlias, recordPosthogAlias } from '../posthog-alias-storage';

// The alias storage module gates on `hasAnalyticsConsent()`, which reads
// the consent cookie. Set/clear a `granted` cookie around each test so the
// storage path executes; consent-denied behaviour gets a dedicated case.
function setConsentCookie(decision: 'granted' | 'denied'): void {
  const flag = decision === 'granted' ? '1' : '0';
  document.cookie = `${CONSENT_COOKIE}=a=${flag}&e=${flag}&v=${CONSENT_POLICY_VERSION}; path=/`;
}

function clearConsentCookie(): void {
  document.cookie = `${CONSENT_COOKIE}=; path=/; max-age=0`;
}

describe('posthog alias storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setConsentCookie('granted');
  });

  afterEach(() => {
    clearConsentCookie();
  });

  it('records alias pairs durably', () => {
    expect(hasRecordedPosthogAlias('profile-1', 'user-1')).toBe(false);

    recordPosthogAlias('profile-1', 'user-1');

    expect(hasRecordedPosthogAlias('profile-1', 'user-1')).toBe(true);
    expect(hasRecordedPosthogAlias('profile-1', 'user-2')).toBe(false);
  });

  it('ignores corrupt stored data', () => {
    window.localStorage.setItem('boardsesh:posthog-aliases', '{nope');

    expect(hasRecordedPosthogAlias('profile-1', 'user-1')).toBe(false);
  });

  it('bounds stored aliases to the most recent pairs', () => {
    for (let i = 0; i < 70; i += 1) {
      recordPosthogAlias(`profile-${i}`, `user-${i}`);
    }

    expect(hasRecordedPosthogAlias('profile-0', 'user-0')).toBe(false);
    expect(hasRecordedPosthogAlias('profile-5', 'user-5')).toBe(false);
    expect(hasRecordedPosthogAlias('profile-6', 'user-6')).toBe(true);
    expect(hasRecordedPosthogAlias('profile-69', 'user-69')).toBe(true);
  });

  it('no-ops recordPosthogAlias and reports false from hasRecordedPosthogAlias when consent is denied', () => {
    setConsentCookie('denied');

    recordPosthogAlias('profile-1', 'user-1');

    expect(window.localStorage.getItem('boardsesh:posthog-aliases')).toBeNull();
    expect(hasRecordedPosthogAlias('profile-1', 'user-1')).toBe(false);
  });
});
