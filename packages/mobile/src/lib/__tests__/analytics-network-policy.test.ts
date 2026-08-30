import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  capture: vi.fn(),
  identify: vi.fn(),
  setPersonProperties: vi.fn(),
  alias: vi.fn(),
  reset: vi.fn(),
  screen: vi.fn(),
  register: vi.fn(),
  startSessionRecording: vi.fn(),
  stopSessionRecording: vi.fn(),
}));
const getPostHogClient = vi.hoisted(() => vi.fn(() => client));

vi.mock('../posthog-client', () => ({
  getPostHogClient,
  registerAppSuperProperties: vi.fn(),
}));

import {
  alias,
  getAnalyticsClient,
  identify,
  readPosthogFeatureFlags,
  registerSuperProperties,
  setPersonProperties,
  setSessionRecordingEnabled,
  subscribePosthogFeatureFlags,
  track,
  trackScreen,
} from '../analytics';
import { setNetworkPolicy } from '../network-policy';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setNetworkPolicy('online');
});

describe('analytics network policy', () => {
  it.each(['local-catalog-only', 'account-offline'] as const)(
    'makes every central PostHog surface a zero-call sink in %s mode',
    (policy) => {
      setNetworkPolicy(policy);

      track('Blocked event');
      expect(identify('profile-id')).toBe(false);
      expect(setPersonProperties({ cohort: 'blocked' })).toBe(false);
      expect(alias('account-id')).toBe(false);
      trackScreen('/(tabs)/climbs');
      registerSuperProperties({ offline: true });
      setSessionRecordingEnabled(true);
      expect(readPosthogFeatureFlags([{ key: 'flag' }])).toEqual({});
      expect(subscribePosthogFeatureFlags(vi.fn())).toEqual(expect.any(Function));
      expect(getAnalyticsClient()).toBeNull();

      expect(getPostHogClient).not.toHaveBeenCalled();
      for (const sink of Object.values(client)) expect(sink).not.toHaveBeenCalled();
    },
  );
});
