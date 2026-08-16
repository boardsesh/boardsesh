import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Gym } from '@boardsesh/shared-schema';

vi.mock('server-only', () => ({}));

// Next's real navigation helpers throw and stop the render; sentinels keep the
// control flow honest instead of letting the page fall through.
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

const getServerAuthToken = vi.hoisted(() => vi.fn(async () => undefined as string | undefined));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken }));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const posterModule = await import('../page');
const GymPosterPage = posterModule.default;
const { generateMetadata } = posterModule;

function gymFixture(overrides: Partial<Gym>): Gym {
  return {
    uuid: 'uuid-1',
    slug: 'boulderwelt-ost',
    name: 'Boulderwelt Ost',
    isPublic: true,
    canEdit: false,
    ...overrides,
  } as unknown as Gym;
}

// `fetchGymBySlug` is wrapped in React's `cache()`, so every test addresses a
// slug of its own rather than relying on the mock being re-read.
async function renderPoster(slug: string) {
  return GymPosterPage({ params: Promise.resolve({ gym_slug: slug }) });
}

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
  getServerAuthToken.mockReset();
  getServerAuthToken.mockResolvedValue(undefined);
});

describe('gym poster route', () => {
  it('renders for a public gym', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'poster-public' }) });
    await expect(renderPoster('poster-public')).resolves.toBeTruthy();
  });

  it('renders for a private gym the viewer can edit, so an owner can print before going public', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gymFixture({ slug: 'poster-private', isPublic: false, canEdit: true }),
    });
    await expect(renderPoster('poster-private')).resolves.toBeTruthy();
  });

  it('404s a private gym the viewer cannot edit — the poster must not leak its existence', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gymFixture({ slug: 'poster-hidden', isPublic: false, canEdit: false }),
    });
    await expect(renderPoster('poster-hidden')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s a missing gym', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: null });
    await expect(renderPoster('poster-nope')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('308s a merged twin onto the canonical slug, keeping /poster', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'poster-canonical' }) });
    try {
      await renderPoster('poster-old-twin');
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectSignal);
      expect((error as RedirectSignal).target).toBe('/gym/poster-canonical/poster');
      return;
    }
    throw new Error('expected a redirect');
  });

  it('percent-encodes the canonical slug in the redirect', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'boulder#1' }) });
    try {
      await renderPoster('poster-old-hash');
    } catch (error) {
      expect((error as RedirectSignal).target).toBe('/gym/boulder%231/poster');
      return;
    }
    throw new Error('expected a redirect');
  });
});

describe('gym poster metadata', () => {
  it('is noindex and emits no canonical or hreflang — a utility surface has nothing to canonicalise', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'poster-meta' }) });
    const metadata = await generateMetadata({ params: Promise.resolve({ gym_slug: 'poster-meta' }) });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    // No `path` is passed, so `createPageMetadata` builds no alternates at all.
    // hreflang is only honoured between mutually indexable pages, and a
    // canonical beside a noindex directive is a contradictory pair.
    expect(metadata.alternates).toBeUndefined();
  });

  it('does not name a gym the viewer cannot see', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({
      gymBySlug: gymFixture({ slug: 'poster-meta-hidden', name: 'Secret Gym', isPublic: false, canEdit: false }),
    });
    const metadata = await generateMetadata({ params: Promise.resolve({ gym_slug: 'poster-meta-hidden' }) });

    expect(JSON.stringify(metadata)).not.toContain('Secret Gym');
  });
});
