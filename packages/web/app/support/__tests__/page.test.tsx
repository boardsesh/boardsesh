import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SupportConfiguration, SupporterStatus } from '@boardsesh/graphql/operations/support';

const { request, getServerAuthToken, decode, createClient } = vi.hoisted(() => ({
  request: vi.fn(),
  getServerAuthToken: vi.fn(),
  decode: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock('next-auth/jwt', () => ({ decode }));
vi.mock('@/app/lib/seo/metadata', () => ({ createPageMetadata: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation: vi.fn() }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: createClient }));
vi.mock('@/app/components/providers/i18n-provider', () => ({ default: () => null }));
vi.mock('../support-content', () => ({ default: () => null }));

import SupportPage from '../page';

const backendConfiguration = {
  enabled: false,
  currency: 'USD',
  minimumAmount: 100,
  maximumAmount: 50_000,
  legacyDonateUrl: null as string | null,
};

async function renderedSupportProps() {
  const page = (await SupportPage()) as React.ReactElement<{
    children: React.ReactElement<{
      configuration: SupportConfiguration;
      initialUserId: string | null;
      initialStatus: SupporterStatus;
    }>;
  }>;
  return page.props.children.props;
}

async function renderedConfiguration() {
  return (await renderedSupportProps()).configuration;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  request.mockReset();
  getServerAuthToken.mockReset().mockResolvedValue(null);
  decode.mockReset();
  createClient.mockReset().mockReturnValue({ request });
});

afterEach(() => vi.unstubAllEnvs());

describe('support page fallback during rollout', () => {
  it('uses the web service link when the backend returns no legacy link', async () => {
    vi.stubEnv('STRIPE_DONATE_URL', 'https://donate.stripe.com/web_link');
    request.mockResolvedValue({ supportConfiguration: backendConfiguration, mySupporterStatus: {} });
    expect(await renderedConfiguration()).toMatchObject({
      enabled: false,
      legacyDonateUrl: 'https://donate.stripe.com/web_link',
    });
  });

  it('preserves the backend link when both services configure one', async () => {
    vi.stubEnv('STRIPE_DONATE_URL', 'https://donate.stripe.com/web_link');
    request.mockResolvedValue({
      supportConfiguration: { ...backendConfiguration, legacyDonateUrl: 'https://donate.stripe.com/backend_link' },
      mySupporterStatus: {},
    });
    expect((await renderedConfiguration()).legacyDonateUrl).toBe('https://donate.stripe.com/backend_link');
  });

  it('rejects a non-HTTPS web fallback even after a successful backend response', async () => {
    vi.stubEnv('STRIPE_DONATE_URL', 'javascript:alert(1)');
    request.mockResolvedValue({ supportConfiguration: backendConfiguration, mySupporterStatus: {} });
    expect((await renderedConfiguration()).legacyDonateUrl).toBeUndefined();
  });

  it('keeps the web fallback when the backend is unavailable', async () => {
    vi.stubEnv('STRIPE_DONATE_URL', 'https://donate.stripe.com/web_link');
    request.mockRejectedValue(new Error('Backend deploying'));
    expect((await renderedConfiguration()).legacyDonateUrl).toBe('https://donate.stripe.com/web_link');
  });
});

describe('support server state ownership', () => {
  const privateStatus = {
    linked: true,
    hasSupported: true,
    showPublicly: true,
    hasActiveSubscription: true,
    cancelAtPeriodEnd: false,
  };

  it('uses the exact validated token subject as the initial supporter owner', async () => {
    vi.stubEnv('NEXTAUTH_SECRET', 'test-secret');
    getServerAuthToken.mockResolvedValue('exact-request-token');
    decode.mockResolvedValue({ sub: 'account-A' });
    request.mockResolvedValue({ supportConfiguration: backendConfiguration, mySupporterStatus: privateStatus });
    expect(await renderedSupportProps()).toMatchObject({ initialUserId: 'account-A', initialStatus: privateStatus });
    expect(decode).toHaveBeenCalledWith({ token: 'exact-request-token', secret: 'test-secret' });
    expect(createClient).toHaveBeenCalledWith('exact-request-token');
  });

  it.each(['malformed', 'missing-secret', 'missing-subject'])(
    'keeps unvalidated %s identities anonymous and private state hidden',
    async (failure) => {
      vi.stubEnv('NEXTAUTH_SECRET', failure === 'missing-secret' ? '' : 'test-secret');
      getServerAuthToken.mockResolvedValue('unvalidated-token');
      if (failure === 'malformed') decode.mockRejectedValue(new Error('Invalid cookie'));
      else decode.mockResolvedValue({});
      request.mockResolvedValue({ supportConfiguration: backendConfiguration, mySupporterStatus: privateStatus });
      expect(await renderedSupportProps()).toMatchObject({
        initialUserId: null,
        initialStatus: { linked: false, hasSupported: false, showPublicly: false, hasActiveSubscription: false },
      });
      expect(createClient).toHaveBeenCalledWith(undefined);
      if (failure === 'missing-secret') expect(decode).not.toHaveBeenCalled();
    },
  );
});
