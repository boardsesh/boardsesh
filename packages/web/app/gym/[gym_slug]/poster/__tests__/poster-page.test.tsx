import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
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

describe('poster sheet structure', () => {
  // The single-page guarantee is a per-block height budget (see the comment on
  // `.sheet`), and that budget is verified by a static print harness that
  // mirrors this markup. Pin the block sequence so the two cannot drift apart
  // silently — and so the block that spills first, the trademark disclaimer,
  // stays visibly last.
  function sheetChildren(tree: React.ReactElement): React.ReactElement[] {
    const found: React.ReactElement[] = [];
    const walk = (node: React.ReactNode): void => {
      if (!React.isValidElement(node)) return;
      const props = node.props as { children?: React.ReactNode };
      if (node.type === 'main') {
        React.Children.forEach(props.children, (child) => {
          if (React.isValidElement(child)) found.push(child);
        });
        return;
      }
      React.Children.forEach(props.children, walk);
    };
    walk(tree);
    return found;
  }

  it('renders the blocks in the order the print budget assumes, disclaimer last', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'poster-structure' }) });
    const tree = (await renderPoster('poster-structure')) as React.ReactElement;

    const kinds = sheetChildren(tree).map((child) =>
      typeof child.type === 'string' ? child.type : ((child.type as { name?: string }).name ?? 'component'),
    );
    // The fixture has no logo, so: name, heading, pitch, QR, typed-URL block,
    // footer block. A gym with a logo adds an <img> in front — the harness
    // measures that case too, since the logo is 18 mm of the height budget.
    expect(kinds).toEqual(['h1', 'p', 'p', 'GymPosterQr', 'div', 'div']);
  });

  it('prints a clean, percent-encoded typed URL — no attribution params on the human line', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'boulder#1' }) });
    const tree = (await renderPoster('boulder#1')) as React.ReactElement;

    const typedBlock = sheetChildren(tree).at(-2) as React.ReactElement;
    const lines: string[] = [];
    React.Children.forEach((typedBlock.props as { children?: React.ReactNode }).children, (child) => {
      if (!React.isValidElement(child)) return;
      const text = (child.props as { children?: unknown }).children;
      if (typeof text === 'string') lines.push(text);
    });

    // Encoded the same way `gymQrUrl` encodes: the code and the line are
    // printed centimetres apart and must not disagree. Scheme stripped, and no
    // `?src=qr&medium=poster` — someone typing a URL off a wall is not a scan.
    expect(lines).toContain('www.boardsesh.com/gym/boulder%231');
    expect(lines.some((line) => line.includes('src=qr'))).toBe(false);
  });

  it('keeps the compatibility line and the non-affiliation line inside the last block', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: gymFixture({ slug: 'poster-footer' }) });
    const tree = (await renderPoster('poster-footer')) as React.ReactElement;

    const lastBlock = sheetChildren(tree).at(-1) as React.ReactElement;
    const lines: string[] = [];
    React.Children.forEach((lastBlock.props as { children?: React.ReactNode }).children, (child) => {
      if (!React.isValidElement(child)) return;
      const text = (child.props as { children?: unknown }).children;
      if (typeof text === 'string') lines.push(text);
    });
    // The i18n mock echoes keys, so these are the catalog paths.
    expect(lines).toContain('gymPage.poster.compatibility');
    expect(lines).toContain('gymPage.poster.independence');
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
