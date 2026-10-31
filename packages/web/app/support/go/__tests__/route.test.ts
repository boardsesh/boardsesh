// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockGetServerSession = vi.fn();
vi.mock('next-auth/next', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));

const mockGetServerAuthToken = vi.fn();
vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: () => mockGetServerAuthToken(),
}));

const mockExecute = vi.fn();
vi.mock('@/app/lib/graphql/server-graphql', () => ({
  executeAuthenticatedGraphQL: (...args: unknown[]) => mockExecute(...args),
}));

const { GET } = await import('../route');

// Placeholder links: the real ones live only in the Railway env.
const MONTHLY_AUD_1 = 'https://buy.stripe.com/test_aud_one';
const MONTHLY_AUD_2 = 'https://buy.stripe.com/test_aud_two';
const ONCE_USD = 'https://donate.stripe.com/test_usd_once';
const CLAIM_ID = `sc_${'0f'.repeat(16)}`;

const ENV_KEYS = [
  'SUPPORT_MONTHLY_LINKS_AUD',
  'SUPPORT_MONTHLY_LINKS_USD',
  'STRIPE_DONATE_URL',
  'STRIPE_DONATE_URL_USD',
];

function request(query: string): NextRequest {
  return new NextRequest(`https://boardsesh.com/support/go?${query}`);
}

function location(response: Response): string {
  const value = response.headers.get('location');
  if (!value) throw new Error('no Location header');
  return value;
}

function signIn() {
  mockGetServerSession.mockResolvedValue({ user: { id: 'user-1', email: 'climber@example.com' } });
  mockGetServerAuthToken.mockResolvedValue('session-jwt');
  mockExecute.mockResolvedValue({ createSupportClaim: CLAIM_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const key of ENV_KEYS) vi.stubEnv(key, '');
  vi.stubEnv(
    'SUPPORT_MONTHLY_LINKS_AUD',
    JSON.stringify([
      { label: 'Tier A', url: MONTHLY_AUD_1 },
      { label: 'Tier B', url: MONTHLY_AUD_2 },
    ]),
  );
  vi.stubEnv('STRIPE_DONATE_URL_USD', ONCE_USD);
  mockGetServerSession.mockResolvedValue(null);
  mockGetServerAuthToken.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /support/go', () => {
  describe('allow-list', () => {
    it.each([
      ['an unknown key', 'link=monthly-aud-9&src=web-support'],
      ['a currency without that link', 'link=once-aud&src=web-support'],
      ['a raw URL', `link=${encodeURIComponent('https://evil.example/pay')}&src=web-support`],
      ['no key at all', 'src=web-support'],
    ])('sends %s back to /support and never to Stripe or elsewhere', async (_label, query) => {
      const response = await GET(request(query));

      expect(response.status).toBe(302);
      expect(location(response)).toBe('/support?src=web-support');
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('cleans the src it echoes back', async () => {
      const response = await GET(request(`link=nope&src=${encodeURIComponent('<script>Evil Src')}`));

      expect(location(response)).toBe('/support?src=scriptevilsrc');
    });
  });

  describe('signed out', () => {
    it('redirects to the Payment Link tagged with src, as the buttons did before', async () => {
      const response = await GET(request('link=monthly-aud-2&src=web-home-banner'));

      expect(response.status).toBe(302);
      const target = new URL(location(response));
      expect(`${target.origin}${target.pathname}`).toBe(MONTHLY_AUD_2);
      expect(target.searchParams.get('client_reference_id')).toBe('web-home-banner');
      expect(target.searchParams.get('utm_source')).toBe('web-home-banner');
      expect(target.searchParams.has('prefilled_email')).toBe(false);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('never lets a browser or edge cache the redirect', async () => {
      const response = await GET(request('link=once-usd&src=web-support'));

      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    });

    it('does not claim when a session has no backend token', async () => {
      mockGetServerSession.mockResolvedValue({ user: { id: 'user-1', email: 'climber@example.com' } });

      const response = await GET(request('link=once-usd&src=web-support'));

      expect(new URL(location(response)).searchParams.get('client_reference_id')).toBe('web-support');
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('signed in', () => {
    it('creates a monthly claim and puts it and the email on the Payment Link', async () => {
      signIn();

      const response = await GET(request('link=monthly-aud-1&src=web-support'));

      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [, variables, authToken, signal] = mockExecute.mock.calls[0]!;
      expect(variables).toEqual({ cadence: 'monthly', currency: 'aud', src: 'web-support' });
      expect(authToken).toBe('session-jwt');
      expect(signal).toBeInstanceOf(AbortSignal);
      const target = new URL(location(response));
      expect(`${target.origin}${target.pathname}`).toBe(MONTHLY_AUD_1);
      expect(target.searchParams.get('client_reference_id')).toBe(CLAIM_ID);
      expect(target.searchParams.get('prefilled_email')).toBe('climber@example.com');
      expect(target.searchParams.get('utm_source')).toBe('web-support');
    });

    it('asks for a one_time claim in the link currency for a one-off button', async () => {
      signIn();

      await GET(request('link=once-usd&src=web-support'));

      expect(mockExecute.mock.calls[0]![1]).toEqual({ cadence: 'one_time', currency: 'usd', src: 'web-support' });
    });

    it('falls back to the src-tagged link when the claim call fails', async () => {
      signIn();
      mockExecute.mockRejectedValue(new Error('backend down'));

      const response = await GET(request('link=once-usd&src=web-support'));

      const target = new URL(location(response));
      expect(`${target.origin}${target.pathname}`).toBe(ONCE_USD);
      expect(target.searchParams.get('client_reference_id')).toBe('web-support');
      expect(target.searchParams.has('prefilled_email')).toBe(false);
    });

    it('falls back when the backend answers with something that is not a claim id', async () => {
      signIn();
      mockExecute.mockResolvedValue({ createSupportClaim: 'web-support' });

      const response = await GET(request('link=once-usd&src=web-support'));

      expect(new URL(location(response)).searchParams.get('client_reference_id')).toBe('web-support');
    });

    it('falls back when reading the session throws', async () => {
      mockGetServerSession.mockRejectedValue(new Error('NEXTAUTH_SECRET missing'));

      const response = await GET(request('link=once-usd&src=web-support'));

      expect(new URL(location(response)).searchParams.get('client_reference_id')).toBe('web-support');
    });
  });
});
