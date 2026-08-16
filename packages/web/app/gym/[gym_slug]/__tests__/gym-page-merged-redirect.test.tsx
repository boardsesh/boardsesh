import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Gym } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));

// Next's real `permanentRedirect` throws NEXT_REDIRECT and nothing after it
// runs. A plain spy would let the page fall through into rendering, so the
// sentinel keeps the control flow honest and makes the assertion one catch.
class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`permanentRedirect:${target}`);
  }
}
class NotFoundSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  permanentRedirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string) => key,
    locale: 'en-US',
  })),
}));

vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));

vi.mock('@/app/lib/auth/server-auth', () => ({
  getServerAuthToken: vi.fn(async () => undefined),
}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('../page')).default;

function mergedGym(canonicalSlug: string): Gym {
  return {
    uuid: `uuid-${canonicalSlug}`,
    slug: canonicalSlug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
  } as unknown as Gym;
}

// `fetchGymBySlug` is wrapped in React's `cache()`, so each test uses a slug of
// its own instead of relying on the mock being re-read for the same arguments.
async function redirectTargetFor(
  requestedSlug: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  try {
    await GymPage({
      params: Promise.resolve({ gym_slug: requestedSlug }),
      searchParams: Promise.resolve(searchParams),
    });
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe('merged-gym 308 redirect', () => {
  it('keeps a printed poster attributable after the gym is merged into another listing', async () => {
    // #4379's headline acceptance criterion. The poster is laminated and on a
    // wall; the gym it names gets merged a year later. Before this change the
    // 308 dropped the query, so every scan of that poster landed on the
    // canonical page with no params — no `Gym QR Scanned`, no attribution, and
    // nothing to tell the gym the poster was working.
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: mergedGym('boulderwelt-ost') });

    await expect(redirectTargetFor('old-boulderwelt', { src: 'qr', medium: 'poster' })).resolves.toBe(
      '/gym/boulderwelt-ost?src=qr&medium=poster',
    );
  });

  it('redirects to a clean URL with no trailing "?" when there were no params', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: mergedGym('boulderwelt-west') });

    await expect(redirectTargetFor('old-west', {})).resolves.toBe('/gym/boulderwelt-west');
  });

  it('carries a kiosk scan through the merge too', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: mergedGym('boulderwelt-sued') });

    await expect(redirectTargetFor('old-sued', { src: 'qr', medium: 'kiosk' })).resolves.toBe(
      '/gym/boulderwelt-sued?src=qr&medium=kiosk',
    );
  });

  it('does not echo a crafted medium through the redirect', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: mergedGym('boulderwelt-nord') });

    await expect(redirectTargetFor('old-nord', { src: 'qr', medium: 'evil' })).resolves.toBe('/gym/boulderwelt-nord');
  });

  it('does not echo any other param a crafted link carries', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: mergedGym('boulderwelt-city') });

    await expect(
      redirectTargetFor('old-city', {
        src: 'qr',
        medium: 'poster',
        utm_campaign: 'someone-elses',
        next: 'https://evil.example.com',
        claim: '1',
      }),
    ).resolves.toBe('/gym/boulderwelt-city?src=qr&medium=poster');
  });
});
