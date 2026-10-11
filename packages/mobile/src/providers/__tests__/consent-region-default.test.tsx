// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { isAnalyticsGranted, isRegionDefaultConsent, type ConsentRecord } from '@boardsesh/consent';
import { GET_MY_ANALYTICS_CONSENT, SET_ANALYTICS_CONSENT } from '@boardsesh/graphql/operations/analytics-consent';

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/consent-auth-invalidation', () => ({}));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 0,
  isAuthCredentialGenerationCurrent: () => true,
  getAuthToken: async () => `header.${btoa(JSON.stringify({ sub: 'account-a' }))}.signature`,
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
import {
  ConsentProvider,
  applyRegionDefaultConsent,
  clearRegionDefaultConsent,
  decideAnalyticsConsent,
  getConsentCoordinator,
} from '../consent-provider';
import { getConsentSnapshot, updateConsentState } from '../../lib/consent-state';

function consentCookie(): string | undefined {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('boardsesh-consent='))
    ?.slice('boardsesh-consent='.length);
}

it('keeps the region default on the device, and a Settings toggle turns it into an explicit answer', async () => {
  const writes: unknown[] = [];
  network.request.mockImplementation(
    async ({ document, variables }: { document: string; variables?: { input: ConsentRecord } }) => {
      if (document === GET_MY_ANALYTICS_CONSENT) return { myAnalyticsConsent: null };
      if (document === SET_ANALYTICS_CONSENT) {
        writes.push(variables?.input);
        return {
          setAnalyticsConsent: { ...variables!.input, decidedAt: '2026-10-11T10:00:00.000Z' },
        };
      }
      throw new Error('unexpected operation');
    },
  );
  const view = render(createElement(ConsentProvider, null, createElement('span', null, 'app')));
  await waitFor(() => expect(getConsentSnapshot().loaded).toBe(true));
  const controller = getConsentCoordinator()!;
  expect(getConsentSnapshot().record).toBeNull();

  // Signed in to an account that never answered.
  act(() => {
    updateConsentState({ authSettled: true, accountId: 'account-a', accountResolved: false, settled: true });
    controller.setAccount('account-a');
  });
  await act(async () => {
    await controller.sync();
  });

  // Outside the prompt regions: analytics on, on this device only.
  await act(async () => {
    applyRegionDefaultConsent('web');
    await controller.sync();
  });
  expect(isRegionDefaultConsent(getConsentSnapshot().record)).toBe(true);
  expect(isAnalyticsGranted(getConsentSnapshot().record)).toBe(true);
  expect(consentCookie()).toMatch(/^v1\.granted\.\d+\.web\.region$/);
  expect(writes).toEqual([]);

  // A region default never overwrites an answer, and clearing never drops one.
  await act(async () => {
    await decideAnalyticsConsent('denied', 'web');
  });
  expect(writes).toEqual([expect.objectContaining({ analytics: 'denied', source: 'web' })]);
  expect(isRegionDefaultConsent(getConsentSnapshot().record)).toBe(false);
  expect(consentCookie()).toMatch(/^v1\.denied\.\d+\.web$/);
  act(() => {
    applyRegionDefaultConsent('web');
    clearRegionDefaultConsent();
  });
  expect(getConsentSnapshot().record?.analytics).toBe('denied');
  expect(consentCookie()).toMatch(/^v1\.denied\.\d+\.web$/);

  // Switching it back on in Settings is an explicit grant that syncs as today.
  await act(async () => {
    await decideAnalyticsConsent('granted', 'web');
  });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ analytics: 'granted' });
  expect(isRegionDefaultConsent(getConsentSnapshot().record)).toBe(false);
  view.unmount();
});

it('drops only a region default when a prompt region asks again', async () => {
  network.request.mockReset().mockResolvedValue({ myAnalyticsConsent: null });
  const controller = getConsentCoordinator()!;
  act(() => {
    controller.setAccount(null);
    controller.replaceLocalRecord(null);
  });
  act(() => {
    applyRegionDefaultConsent('ios');
  });
  expect(isRegionDefaultConsent(getConsentSnapshot().record)).toBe(true);
  act(() => {
    clearRegionDefaultConsent();
  });
  expect(getConsentSnapshot().record).toBeNull();
  expect(consentCookie() ?? '').toBe('');
});
