import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { SupportConfiguration } from '@boardsesh/graphql/operations/support';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/app/lib/seo/metadata', () => ({ createPageMetadata: vi.fn() }));
vi.mock('@/app/lib/i18n/server', () => ({ getServerTranslation: vi.fn() }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'en-US' }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: async () => null }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));
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

async function renderedConfiguration() {
  const page = (await SupportPage()) as React.ReactElement<{
    children: React.ReactElement<{ configuration: SupportConfiguration }>;
  }>;
  return page.props.children.props.configuration;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  request.mockReset();
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
