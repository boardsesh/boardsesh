// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { expect, it, vi } from 'vitest';
import { isAnalyticsGranted, type ConsentRecord } from '@boardsesh/consent';
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
import { ConsentProvider, decideAnalyticsConsent, getConsentCoordinator } from '../consent-provider';
import { getConsentSnapshot, updateConsentState } from '../../lib/consent-state';

function consentCookie(): string | undefined {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('boardsesh-consent='))
    ?.slice('boardsesh-consent='.length);
}

it('keeps analytics off until a Settings decision, and syncs explicit choices', async () => {
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

  expect(isAnalyticsGranted(getConsentSnapshot().record)).toBe(false);
  expect(consentCookie()).toBeUndefined();
  expect(writes).toEqual([]);

  // A Settings denial is an explicit answer.
  await act(async () => {
    await decideAnalyticsConsent('denied', 'web');
  });
  expect(writes).toEqual([expect.objectContaining({ analytics: 'denied', source: 'web' })]);
  expect(consentCookie()).toMatch(/^v1\.denied\.\d+\.web$/);
  // Switching it back on in Settings is an explicit grant that syncs as today.
  await act(async () => {
    await decideAnalyticsConsent('granted', 'web');
  });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ analytics: 'granted' });
  view.unmount();
});
