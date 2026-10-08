// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateConsentState } from '../../../lib/consent-state';
import { grantedConsent } from '../../../../test/consent-fixture';

const state = vi.hoisted(() => ({
  consentSettled: false,
  launchReady: true,
  effectiveOffline: false,
  profile: { id: 'account-a' },
  privacy: { enabled: true, privacyOnboardingVersion: 0 },
  segments: ['(tabs)', 'home'],
  push: vi.fn(),
}));
vi.mock('expo-router', () => ({ useSegments: () => state.segments }));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: state.push } }));
vi.mock('../../../providers/launch-ready-context', () => ({ useLaunchReady: () => state.launchReady }));
vi.mock('../../../lib/consent-hooks', () => ({ useConsentSettled: () => state.consentSettled }));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.effectiveOffline }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({ useProfile: () => ({ data: state.profile }) }));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  PRIVACY_ONBOARDING_VERSION: 1,
  usePrivacySettings: () => ({ data: state.privacy }),
}));

import { PrivacyOnboardingGate } from '../PrivacyOnboardingGate';

beforeEach(() => {
  vi.useFakeTimers();
  state.push.mockClear();
  state.consentSettled = false;
  state.launchReady = true;
  state.effectiveOffline = false;
  state.privacy = { enabled: true, privacyOnboardingVersion: 0 };
  state.segments = ['(tabs)', 'home'];
  updateConsentState({ settled: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('privacy setup after the analytics choice', () => {
  it('waits for consent settlement before starting its presentation timer', () => {
    const view = render(<PrivacyOnboardingGate />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(state.push).not.toHaveBeenCalled();

    updateConsentState({ settled: true });
    state.consentSettled = true;
    view.rerender(<PrivacyOnboardingGate />);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(state.push).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/settings/privacy-onboarding');
  });

  it('rechecks synchronous consent authority before a previously scheduled timer navigates', () => {
    state.consentSettled = true;
    updateConsentState({ settled: true });
    const view = render(<PrivacyOnboardingGate />);
    // Model a consent invalidation before React has published the new hook result.
    updateConsentState({ settled: false });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(state.push).not.toHaveBeenCalled();

    state.consentSettled = false;
    view.rerender(<PrivacyOnboardingGate />);
    updateConsentState({ settled: true });
    state.consentSettled = true;
    view.rerender(<PrivacyOnboardingGate />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/settings/privacy-onboarding');
  });

  it('still presents account privacy setup when analytics was declined', () => {
    updateConsentState({ record: { ...grantedConsent, analytics: 'denied' }, settled: true });
    state.consentSettled = true;
    render(<PrivacyOnboardingGate />);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(state.push).toHaveBeenCalledExactlyOnceWith('/settings/privacy-onboarding');
  });
});
