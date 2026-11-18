import { beforeEach, expect, it, vi } from 'vitest';
import type { PostHog } from 'posthog-react-native';
import { grantAnalyticsForTest, grantedConsent } from '../../../test/consent-fixture';
import { updateConsentState } from '../consent-state';
vi.mock('../replay-privacy', () => ({ isNativeReplayPrivacyReady: () => true }));
import { applySessionReplayConsent } from '../session-replay-consent';

beforeEach(() => grantAnalyticsForTest());
it.each([
  { setting: false, record: grantedConsent, starts: false },
  { setting: true, record: null, starts: false },
  { setting: true, record: { ...grantedConsent, analytics: 'denied' as const }, starts: false },
  { setting: true, record: { ...grantedConsent, basis: 'region_default' as const }, starts: false },
  { setting: true, record: grantedConsent, starts: true },
])('requires both the recording setting and explicit analytics consent: %j', async ({ setting, record, starts }) => {
  updateConsentState({ record });
  const startSessionRecording = vi.fn(async () => {});
  const stopSessionRecording = vi.fn(async () => {});
  const client = { startSessionRecording, stopSessionRecording } as unknown as PostHog;
  await applySessionReplayConsent(client, setting);
  expect(startSessionRecording).toHaveBeenCalledTimes(starts ? 1 : 0);
  if (!starts) expect(stopSessionRecording).toHaveBeenCalled();
});
