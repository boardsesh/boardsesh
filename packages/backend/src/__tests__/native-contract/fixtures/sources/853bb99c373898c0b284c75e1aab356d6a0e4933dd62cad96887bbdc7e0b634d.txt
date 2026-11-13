import type { PostHog } from 'posthog-react-native';
import { isProductAnalyticsGranted } from './consent-state';
import { isNativeReplayPrivacyReady } from './replay-privacy';

let desiredRecording = false;
let revision = 0;
let transitions: Promise<void> = Promise.resolve();

/** Native start can outlive the JS decision. A late start must always be stopped. */
export function applySessionReplayConsent(client: PostHog, enabled: boolean): Promise<void> {
  desiredRecording = enabled && isProductAnalyticsGranted() && isNativeReplayPrivacyReady();
  const requestRevision = ++revision;
  if (!desiredRecording) void client.stopSessionRecording();
  transitions = transitions
    .catch(() => {})
    .then(async () => {
      if (
        requestRevision !== revision ||
        !desiredRecording ||
        !isProductAnalyticsGranted() ||
        !isNativeReplayPrivacyReady()
      ) {
        await client.stopSessionRecording();
        return;
      }
      await client.startSessionRecording();
      if (
        requestRevision !== revision ||
        !desiredRecording ||
        !isProductAnalyticsGranted() ||
        !isNativeReplayPrivacyReady()
      ) {
        await client.stopSessionRecording();
      }
    });
  return transitions;
}
