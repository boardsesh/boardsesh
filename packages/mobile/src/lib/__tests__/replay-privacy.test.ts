import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ setOptOut: vi.fn(async (_optedOut: boolean, _key: string) => {}) }));
vi.mock('posthog-react-native-session-replay', () => ({ setOptOut: bridge.setOptOut }));
vi.mock('../is-dev-build', () => ({ isDevBuild: () => false }));
vi.mock('../posthog-storage-backend', () => ({
  posthogStorageBackend: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
beforeEach(() => {
  vi.resetModules();
  bridge.setOptOut.mockReset();
  vi.stubEnv('EXPO_PUBLIC_POSTHOG_KEY', 'phc_replay_privacy');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('missing native capability keeps replay disabled while the enabled memory flags client still initializes', async () => {
  bridge.setOptOut.mockRejectedValue(new Error('missing native method'));
  const consent = await import('../consent-state');
  consent.updateConsentState({
    loaded: true,
    settled: true,
    flagsResolved: true,
    record: { analytics: 'granted', version: 1, source: 'ios', decidedAt: '2026-10-08T12:00:00Z' },
    authSettled: true,
    accountResolved: true,
  });
  const posthog = await import('../posthog-client');
  await posthog.initializePosthogClient();
  const privacy = await import('../replay-privacy');
  const replay = await import('../session-replay-consent');
  const client = posthog.getPostHogClient()!;
  const start = vi.spyOn(client, 'startSessionRecording');
  expect(client).not.toBeNull();
  expect(privacy.isNativeReplayPrivacyReady()).toBe(false);
  await replay.applySessionReplayConsent(client, true);
  expect(start).not.toHaveBeenCalled();
});
it('a delayed native grant cannot become ready after a newer failed withdrawal', async () => {
  let finishGrant: (() => void) | undefined;
  bridge.setOptOut
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishGrant = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('purge failed'));
  const privacy = await import('../replay-privacy');
  const granting = privacy.applyNativeReplayPrivacy(true, 'phc_test');
  await privacy.applyNativeReplayPrivacy(false, 'phc_test');
  expect(privacy.isNativeReplayPrivacyReady()).toBe(false);
  finishGrant?.();
  await granting;
  expect(privacy.isNativeReplayPrivacyReady()).toBe(false);
});
it('a successful native grant is disabled immediately by a failing purge', async () => {
  bridge.setOptOut.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('purge failed'));
  const privacy = await import('../replay-privacy');
  await privacy.applyNativeReplayPrivacy(true, 'phc_test');
  expect(privacy.isNativeReplayPrivacyReady()).toBe(true);
  const revoking = privacy.applyNativeReplayPrivacy(false, 'phc_test');
  expect(privacy.isNativeReplayPrivacyReady()).toBe(false);
  await revoking;
});
it('a deferred grant completes native privacy before SDK readiness and starts the saved recording preference', async () => {
  bridge.setOptOut.mockResolvedValue(undefined);
  const consent = await import('../consent-state');
  consent.updateConsentState({
    loaded: true,
    settled: true,
    flagsResolved: true,
    record: { analytics: 'granted', version: 1, source: 'ios', decidedAt: '2026-10-08T12:00:00Z' },
    authSettled: false,
    accountResolved: false,
  });
  const posthog = await import('../posthog-client');
  await posthog.initializePosthogClient();
  let finishGrant: (() => void) | undefined;
  bridge.setOptOut.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishGrant = resolve;
      }),
  );
  consent.updateConsentState({ authSettled: true, accountResolved: true });
  const granting = posthog.applyPosthogConsent();
  await vi.waitFor(() => expect(finishGrant).toBeDefined());
  expect(consent.isProductAnalyticsGranted()).toBe(false);
  finishGrant?.();
  await granting;
  expect(consent.isProductAnalyticsGranted()).toBe(true);
  const client = posthog.getPostHogClient()!;
  const start = vi.spyOn(client, 'startSessionRecording');
  const replay = await import('../session-replay-consent');
  await replay.applySessionReplayConsent(client, true);
  expect(start).toHaveBeenCalledOnce();
  consent.updateConsentState({ accountResolved: false });
  await posthog.applyPosthogConsent();
  expect(consent.getConsentSnapshot().sdkReady).toBe(false);
  let finishRestoredGrant: (() => void) | undefined;
  bridge.setOptOut.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRestoredGrant = resolve;
      }),
  );
  consent.updateConsentState({ accountResolved: true });
  const restoring = posthog.applyPosthogConsent();
  await vi.waitFor(() => expect(finishRestoredGrant).toBeDefined());
  expect(consent.isProductAnalyticsGranted()).toBe(false);
  finishRestoredGrant?.();
  await restoring;
  expect(consent.getConsentSnapshot().sdkReady).toBe(true);
  await replay.applySessionReplayConsent(client, true);
  expect(start).toHaveBeenCalledTimes(2);
  consent.updateConsentState({ record: { ...consent.getConsentSnapshot().record!, analytics: 'denied' } });
  const withdrawing = posthog.applyPosthogConsent();
  expect(consent.isProductAnalyticsGranted()).toBe(false);
  expect((await import('../replay-privacy')).isNativeReplayPrivacyReady()).toBe(false);
  await withdrawing;
});
