// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, locale: 'en-US' }));
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: async () => state.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: request }));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: state.locale }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

import PartnerSessionHistoryPage, { generateMetadata } from '@/app/(site)/history/session/[exportId]/page';

const EXPORT_ID = '3c2d56f7-1f63-4c63-9c48-3c239b14727d';
const props = { params: Promise.resolve({ exportId: EXPORT_ID }) };

beforeEach(() => {
  state.token = undefined;
  state.locale = 'en-US';
  request.mockReset();
});

describe('authenticated partner history landing', () => {
  it('preserves the localized opaque destination through sign-in', async () => {
    state.locale = 'fr';
    await expect(PartnerSessionHistoryPage(props)).rejects.toThrow(
      `redirect:/fr/auth/login?callbackUrl=${encodeURIComponent(`/fr/history/session/${EXPORT_ID}`)}`,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves only with first-party credentials and opens read-only detail', async () => {
    state.token = 'first-party-token';
    request.mockResolvedValue({ resolvePartnerSessionHistory: 'internal-session-id' });
    await expect(PartnerSessionHistoryPage(props)).rejects.toThrow('redirect:/session/internal-session-id');
    expect(request).toHaveBeenCalledWith(expect.anything(), { exportId: EXPORT_ID }, 'first-party-token');
  });

  it('denies another account without revealing the internal session identifier', async () => {
    state.token = 'another-account';
    request.mockResolvedValue({ resolvePartnerSessionHistory: null });
    await expect(PartnerSessionHistoryPage(props)).rejects.toThrow('not found');
  });

  it('does not turn a temporary backend outage into a missing session', async () => {
    state.token = 'first-party-token';
    request.mockRejectedValue(new Error('backend temporarily unavailable'));
    await expect(PartnerSessionHistoryPage(props)).rejects.toThrow('backend temporarily unavailable');
  });

  it('rejects malformed references and keeps the route out of search', async () => {
    await expect(PartnerSessionHistoryPage({ params: Promise.resolve({ exportId: '../private' }) })).rejects.toThrow(
      'not found',
    );
    expect(request).not.toHaveBeenCalled();
    expect((await generateMetadata(props)).robots).toEqual({ index: false, follow: true });
  });
});
