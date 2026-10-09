// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { serializeConsentCookieValue, type ConsentRecord } from '@boardsesh/consent';

const auth = vi.hoisted(() => ({ generation: 0, owner: 'account-a' }));
const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/consent-auth-invalidation', () => ({}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => auth.generation,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === auth.generation,
  getAuthToken: async () => `header.${btoa(JSON.stringify({ sub: auth.owner }))}.signature`,
}));
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: network.request }) }));
vi.mock('../../lib/posthog-client', () => ({
  initializePosthogClient: async () => {},
  applyPosthogConsent: async () => {},
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/consent-storage', async () => import('../../lib/consent-storage.web'));
vi.mock('../../lib/preference-store', () => {
  const stored = new Map<string, unknown>();
  return {
    getPreference: async (key: string) => stored.get(key) ?? null,
    setPreference: async (key: string, payload: unknown) => {
      stored.set(key, payload);
    },
    removePreference: async (key: string) => {
      stored.delete(key);
    },
  };
});
import { ConsentProvider, getConsentCoordinator, decideAnalyticsConsent } from '../consent-provider';
import {
  getConsentSnapshot,
  invalidateConsentAccount,
  isProductAnalyticsGranted,
  updateConsentState,
} from '../../lib/consent-state';

const grant: ConsentRecord = { analytics: 'granted', version: 1, decidedAt: '2026-10-08T12:00:00.123Z', source: 'web' };
const deny: ConsentRecord = { ...grant, analytics: 'denied', decidedAt: '2026-10-08T12:01:00.456Z' };

it('real provider rejects an old account response and preserves an offline denial against an external cookie grant', async () => {
  document.cookie = `boardsesh-consent=${serializeConsentCookieValue(grant)}; Path=/`;
  const view = render(createElement(ConsentProvider, null, createElement('span', null, 'app')));
  await waitFor(() => expect(getConsentSnapshot().loaded).toBe(true));
  const controller = getConsentCoordinator()!;
  let finishOldRequest: ((response: { myAnalyticsConsent: ConsentRecord }) => void) | undefined;
  network.request.mockImplementationOnce(
    () =>
      new Promise<{ myAnalyticsConsent: ConsentRecord }>((resolve) => {
        finishOldRequest = resolve;
      }),
  );
  act(() => {
    updateConsentState({
      authSettled: true,
      accountId: 'account-a',
      accountResolved: false,
      settled: true,
      flagsResolved: true,
      sdkReady: true,
    });
    controller.setAccount('account-a');
  });
  const oldSync = controller.sync();
  await waitFor(() => expect(network.request).toHaveBeenCalledOnce());
  act(() => {
    auth.generation++;
    auth.owner = 'account-b';
    invalidateConsentAccount();
    updateConsentState({ authSettled: true, accountId: 'account-b', accountResolved: false });
    controller.setAccount('account-b');
  });
  network.request.mockResolvedValueOnce({ myAnalyticsConsent: grant });
  await act(async () => {
    await controller.sync();
    finishOldRequest?.({ myAnalyticsConsent: deny });
    await oldSync;
  });
  expect(controller.getAccountId()).toBe('account-b');
  expect(getConsentSnapshot().record?.analytics).toBe('granted');
  expect(network.request.mock.calls[0][0].signal.aborted).toBe(true);
  network.request.mockRejectedValue(new Error('offline'));
  await act(async () => {
    await decideAnalyticsConsent('denied', 'web');
  });
  expect(controller.getSnapshot().pending).toBe(true);
  expect(getConsentSnapshot().record?.analytics).toBe('denied');
  document.cookie = `boardsesh-consent=${serializeConsentCookieValue({ ...grant, decidedAt: '2026-10-08T12:03:00Z' })}; Path=/`;
  act(() => {
    expect(isProductAnalyticsGranted()).toBe(false);
  });
  expect(controller.getSnapshot().record?.analytics).toBe('denied');
  expect(getConsentSnapshot().record?.analytics).toBe('denied');
  await act(async () => {
    await controller.sync();
    updateConsentState({ sdkReady: true });
  });
  expect(isProductAnalyticsGranted()).toBe(false);
  expect(getConsentSnapshot().record?.analytics).toBe('denied');
  view.unmount();
});
