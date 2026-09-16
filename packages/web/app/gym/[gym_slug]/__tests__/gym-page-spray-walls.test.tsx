import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import React from 'react';
import type { Gym } from '@boardsesh/shared-schema';

/**
 * SW-14: a gym's spray walls on its public page.
 *
 * Two rules are worth a test rather than a reading. A PUBLIC wall shows its
 * photo, and the URL it shows is `publicPhotoUrl` — the copy in the world-readable
 * bucket — because a logged-out reader cannot hold the fifteen-minute signature
 * every other wall photo is served behind. Any other wall the caller may see gets
 * its name and nothing else; rendering an `<img>` with no src, or falling back to
 * a presigned URL, is the failure this file is here to catch.
 *
 * The third is bookkeeping: a spray wall is an ordinary `user_boards` row, so it
 * comes back in `gymBoards` as well and would otherwise be listed twice.
 */

vi.mock('server-only', () => ({}));

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
  permanentRedirect: () => {
    throw new RedirectSignal('permanentRedirect');
  },
}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn(async () => 'en-US') }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const GymPage = (await import('../page')).default;

function gym(slug: string, overrides: Partial<Gym> = {}): Gym {
  return {
    uuid: `uuid-${slug}`,
    slug,
    name: 'Boulderwelt',
    isPublic: true,
    canEdit: false,
    ...overrides,
  } as unknown as Gym;
}

type SprayWallRow = {
  uuid: string;
  layoutId: number;
  holdCount: number;
  publicPhotoUrl: string | null;
  board: Record<string, unknown>;
};

function sprayWall(name: string, publicPhotoUrl: string | null): SprayWallRow {
  return {
    uuid: `wall-${name}`,
    layoutId: 7,
    holdCount: 120,
    publicPhotoUrl,
    board: {
      uuid: `board-${name}`,
      slug: `slug-${name}`,
      name,
      angle: 40,
      isPublic: publicPhotoUrl !== null,
      isUnlisted: false,
      gymUuid: 'gym-uuid',
      gymName: 'Boulderwelt',
    },
  };
}

/**
 * Route each of the page's GraphQL calls by the operation its document names.
 *
 * The page fires four of them concurrently, so a single `mockResolvedValue`
 * would hand the gym's shape to the board list and the wall list alike.
 */
function respondWith(options: {
  gym: Gym;
  boards?: unknown[];
  sprayWalls?: SprayWallRow[];
  /** Stand in for a backend that has no `gymSprayWalls` field yet. */
  sprayWallsFail?: boolean;
}): void {
  executeAuthenticatedGraphQL.mockImplementation(async (document: unknown) => {
    const text = String(document);
    if (text.includes('gymSprayWalls')) {
      if (options.sprayWallsFail) throw new Error('Cannot query field "gymSprayWalls" on type "Query"');
      return { gymSprayWalls: options.sprayWalls ?? [] };
    }
    if (text.includes('gymBoards')) return { gymBoards: options.boards ?? [] };
    if (text.includes('gymBySlug')) return { gymBySlug: options.gym };
    return {};
  });
}

/** Every element in a rendered-but-not-mounted tree, depth first. */
function allElements(node: React.ReactNode): React.ReactElement[] {
  const found: React.ReactElement[] = [];
  const visit = (current: React.ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    found.push(current);
    visit((current.props as { children?: React.ReactNode }).children);
  };
  visit(node);
  return found;
}

/** Every string rendered anywhere in the tree. */
function allText(node: React.ReactNode): string[] {
  const text: string[] = [];
  const visit = (current: React.ReactNode): void => {
    if (typeof current === 'string') {
      text.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!React.isValidElement(current)) return;
    visit((current.props as { children?: React.ReactNode }).children);
  };
  visit(node);
  return text;
}

const imageSources = (node: React.ReactNode): string[] =>
  allElements(node)
    .filter((element) => (element.props as { component?: unknown }).component === 'img')
    .map((element) => String((element.props as { src?: unknown }).src));

const linkHrefs = (node: React.ReactNode): string[] =>
  allElements(node)
    .map((element) => (element.props as { href?: unknown }).href)
    .filter((href): href is string => typeof href === 'string');

// `fetchGymBySlug` is wrapped in React's `cache()`, so each test uses its own slug.
const renderPage = (slug: string) =>
  GymPage({ params: Promise.resolve({ gym_slug: slug }), searchParams: Promise.resolve({}) });

beforeEach(() => {
  executeAuthenticatedGraphQL.mockReset();
});

describe("a gym page's spray walls", () => {
  it('renders a public wall with the photo from the public copy', async () => {
    respondWith({
      gym: gym('walls-public'),
      sprayWalls: [sprayWall('The Cave', 'https://media.example/spray-walls/wall/abc.jpg')],
    });

    const tree = await renderPage('walls-public');

    expect(allText(tree)).toContain('The Cave');
    expect(imageSources(tree)).toContain('https://media.example/spray-walls/wall/abc.jpg');
    expect(linkHrefs(tree)).toContain('/b/slug-The Cave');
  });

  it('renders a wall with no public copy by name alone, with no image', async () => {
    respondWith({ gym: gym('walls-private'), sprayWalls: [sprayWall('Members Only', null)] });

    const tree = await renderPage('walls-private');

    expect(allText(tree)).toContain('Members Only');
    // No `<img>` for the wall. The gym's own hero photo is absent in this
    // fixture, so any image at all here would be the wall's.
    expect(imageSources(tree)).toHaveLength(0);
  });

  it('lists a spray wall once, not twice — it is a gym board as well', async () => {
    respondWith({
      gym: gym('walls-dedup'),
      boards: [
        { uuid: 'board-rail', slug: 'kilter-rail', name: 'Kilter', boardType: 'kilter', angle: 40 },
        { uuid: 'board-The Cave', slug: 'slug-The Cave', name: 'The Cave', boardType: 'spray', angle: 40 },
      ],
      sprayWalls: [sprayWall('The Cave', 'https://media.example/spray-walls/wall/abc.jpg')],
    });

    const tree = await renderPage('walls-dedup');

    expect(linkHrefs(tree).filter((href) => href === '/b/slug-The Cave')).toHaveLength(1);
    // The rail board is untouched by the filter.
    expect(linkHrefs(tree)).toContain('/b/kilter-rail');
  });

  it('renders no wall section at all when the gym has none', async () => {
    respondWith({ gym: gym('walls-none'), sprayWalls: [] });

    expect(allText(await renderPage('walls-none'))).not.toContain('gymPage.sprayWallsHeading');
  });

  it('leaves the walls in the boards section when the wall query cannot be asked', async () => {
    // The deploy window where web is ahead of backend and `gymSprayWalls` is not
    // a field yet. The dedup filter above only runs when the wall list answered,
    // so the gym's walls keep their old row instead of vanishing off the page.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    respondWith({
      gym: gym('walls-backend-behind'),
      boards: [{ uuid: 'board-The Cave', slug: 'slug-The Cave', name: 'The Cave', boardType: 'spray', angle: 40 }],
      sprayWallsFail: true,
    });

    const tree = await renderPage('walls-backend-behind');

    expect(linkHrefs(tree).filter((href) => href === '/b/slug-The Cave')).toHaveLength(1);
    expect(allText(tree)).not.toContain('gymPage.sprayWallsHeading');
    consoleError.mockRestore();
  });
});
