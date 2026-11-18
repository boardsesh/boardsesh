import { expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../lib/consent-storage', () => ({
  readLocalConsent: storage.read,
  persistLocalConsent: async () => {},
  readPendingConsent: async () => null,
  persistPendingConsent: async () => {},
  readLatestExternalConsent: () => null,
}));
vi.mock('../../lib/consent-auth-invalidation', () => ({}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: () => true,
  getAuthToken: async () => null,
}));
vi.mock('../../lib/posthog-client', () => ({
  initializePosthogClient: async () => {},
  applyPosthogConsent: async () => {},
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: vi.fn() }));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
import { initializeConsent } from '../consent-provider';
import { dismissAnalyticsConsentPrompt, getConsentSnapshot, isProductAnalyticsGranted } from '../../lib/consent-state';
it('keeps an early dismissal when slow storage later resolves without an answer', async () => {
  let finishRead!: (record: null) => void;
  storage.read.mockReturnValue(
    new Promise<null>((resolve) => {
      finishRead = resolve;
    }),
  );
  const loading = initializeConsent();
  dismissAnalyticsConsentPrompt();
  expect(getConsentSnapshot().settled).toBe(true);
  finishRead(null);
  await loading;
  expect(getConsentSnapshot()).toMatchObject({ loaded: true, settled: true, record: null });
  expect(isProductAnalyticsGranted()).toBe(false);
});
