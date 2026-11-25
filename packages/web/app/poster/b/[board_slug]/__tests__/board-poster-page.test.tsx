import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ResolvedBoard } from '@/app/lib/board-slug-utils';
import type { SprayWallPageData } from '@/app/lib/spray/spray-wall-render-data.server';

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
  getServerTranslation: vi.fn(async (ns: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    locale: 'en-US',
  })),
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

// The printed URL is read off the props rather than decoded from a matrix.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: (props: { value: string }) => <svg data-testid="poster-qr" data-value={props.value} />,
}));

const resolveBoardBySlug = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/board-slug-utils', () => ({ resolveBoardBySlug }));

const fetchSprayWallPageData = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/spray/spray-wall-render-data.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/spray/spray-wall-render-data.server')>()),
  fetchSprayWallPageData,
}));

const posterModule = await import('@/app/(site)/poster/b/[board_slug]/page');
const BoardPosterPage = posterModule.default;
const { generateMetadata } = posterModule;

const WALL_UUID = '0144249a-3a8c-47c2-8c1e-54c0c572fe02';
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';
const INVITE_TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';
const PUBLIC_PHOTO = 'https://media.boardsesh.com/spray/public/wall.jpg';

function boardFixture(overrides: Partial<ResolvedBoard> = {}): ResolvedBoard {
  return {
    uuid: WALL_UUID,
    slug: 'sharma-spraywall',
    boardType: 'spray',
    layoutId: 9001,
    sizeId: 1,
    setIds: '1',
    name: 'Sharma big spraywall',
    isPublic: true,
    isUnlisted: false,
    isOwned: true,
    ownerId: 'owner-1',
    angle: 25,
    isAngleAdjustable: false,
    ...overrides,
  };
}

function ledFixture(overrides: Partial<ResolvedBoard> = {}): ResolvedBoard {
  return boardFixture({
    uuid: 'b0a7d000-0000-4000-8000-000000000001',
    slug: 'main-kilter',
    boardType: 'kilter',
    name: 'Main Kilter',
    angle: 40,
    isAngleAdjustable: true,
    locationName: 'Back room',
    ...overrides,
  });
}

function wallData(overrides: { publicPhotoUrl?: string | null; photoUrl?: string } = {}): SprayWallPageData {
  return {
    versionNumber: 3,
    boardWidth: 1000,
    boardHeight: 750,
    photo: { url: overrides.photoUrl ?? 'https://signed.example/wall.jpg?sig=abc', width: 2048, height: 1536 },
    homography: null,
    holds: [],
    wall: {
      uuid: WALL_UUID,
      layoutId: 9001,
      holdCount: 175,
      publicPhotoUrl: overrides.publicPhotoUrl === undefined ? PUBLIC_PHOTO : overrides.publicPhotoUrl,
      name: 'Sharma big spraywall',
      angle: 25,
      gymUuid: 'gym-1',
      gymName: 'Sharma Climbing Gavà',
      ownerDisplayName: 'Alejandro',
    },
  };
}

type PosterSearchParams = Record<string, string | string[] | undefined>;

async function renderPoster(slug: string, searchParams: PosterSearchParams = {}) {
  const tree = await BoardPosterPage({
    params: Promise.resolve({ board_slug: slug }),
    searchParams: Promise.resolve(searchParams),
  });
  return render(tree);
}

function printedQrValues(): string[] {
  return screen.getAllByTestId('poster-qr').map((qr) => qr.getAttribute('data-value') ?? '');
}

function layoutLinks(): Map<string, string> {
  const group = screen.getByRole('group', { name: 'Poster layout' });
  return new Map(
    within(group)
      .getAllByRole('link')
      .map((link) => [link.textContent ?? '', link.getAttribute('href') ?? '']),
  );
}

beforeEach(() => {
  resolveBoardBySlug.mockReset();
  fetchSprayWallPageData.mockReset();
});

describe('board poster — Spraywalls', () => {
  it('prints a public wall on the photo poster by default, with the typed line', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture());
    fetchSprayWallPageData.mockResolvedValue(wallData());
    const { container } = await renderPoster('sharma-spraywall');

    expect(printedQrValues()).toEqual(['https://www.boardsesh.com/b/sharma-spraywall?src=qr&medium=board']);
    expect(container.querySelector(`img[src="${PUBLIC_PHOTO}"]`)).not.toBeNull();
    expect(screen.getByText('www.boardsesh.com/b/')).toBeTruthy();
    expect(screen.getByText('sharma-spraywall')).toBeTruthy();
    expect(screen.getByText('Sharma Climbing Gavà')).toBeTruthy();
    expect([...layoutLinks().keys()]).toEqual(['Photo poster', 'Plain poster', 'Cards']);
    // A Spraywall poster names no board brand.
    expect(container.textContent).not.toContain('Works with');
    expect(container.textContent).not.toContain('Aurora');
  });

  it('asks the backend for the wall with the capability the request carried', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture({ isPublic: false, isUnlisted: true }));
    fetchSprayWallPageData.mockResolvedValue(wallData({ publicPhotoUrl: null }));
    await renderPoster('sharma-spraywall', { wall: WALL_UUID });
    expect(resolveBoardBySlug).toHaveBeenCalledWith('sharma-spraywall', WALL_UUID);
  });

  it('prints an unlisted wall with its capability in the code, no typed line, and a screen-only notice', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture({ isPublic: false, isUnlisted: true }));
    fetchSprayWallPageData.mockResolvedValue(wallData({ publicPhotoUrl: null }));
    const { container } = await renderPoster('sharma-spraywall', { wall: WALL_UUID, layout: 'plain' });

    expect(printedQrValues()).toEqual([
      `https://www.boardsesh.com/b/sharma-spraywall?wall=${WALL_UUID}&src=qr&medium=board`,
    ]);
    expect(screen.queryByText('No camera? Type this in:')).toBeNull();
    expect(screen.getByText('Anyone who scans this can open the Spraywall.')).toBeTruthy();
    // The layout switch and the way back keep the capability, so they open.
    expect(layoutLinks().get('Cards')).toBe(`/poster/b/sharma-spraywall?wall=${WALL_UUID}&layout=cards`);
    expect(screen.getByRole('link', { name: 'Back to the Spraywall' }).getAttribute('href')).toBe(
      `/b/sharma-spraywall?wall=${WALL_UUID}`,
    );
    expect(container.textContent).not.toContain('www.boardsesh.com/b/');
  });

  it("prints an unlisted wall's photo from its presigned URL: the page is never cached", async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture({ isPublic: false, isUnlisted: true }));
    fetchSprayWallPageData.mockResolvedValue(wallData({ publicPhotoUrl: null }));
    const { container } = await renderPoster('sharma-spraywall', { wall: WALL_UUID });

    expect(container.querySelector('img[src="https://signed.example/wall.jpg?sig=abc"]')).not.toBeNull();
  });

  it('prints four cards on the card sheet', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture());
    fetchSprayWallPageData.mockResolvedValue(wallData());
    await renderPoster('sharma-spraywall', { layout: 'cards' });
    expect(printedQrValues()).toHaveLength(4);
  });

  it('never offers the photo poster for a wall without a photo', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture());
    fetchSprayWallPageData.mockResolvedValue(wallData({ publicPhotoUrl: null, photoUrl: '' }));
    const { container } = await renderPoster('sharma-spraywall', { layout: 'photo' });

    expect([...layoutLinks().keys()]).toEqual(['Plain poster', 'Cards']);
    expect(container.querySelector('img[src*="spray"]')).toBeNull();
  });

  it.each([
    ['an unlisted wall without its uuid', { isPublic: false, isUnlisted: true }, {}],
    ['an unlisted wall with the wrong uuid', { isPublic: false, isUnlisted: true }, { wall: OTHER_UUID }],
    ['a public wall with the wrong uuid', {}, { wall: OTHER_UUID }],
    ['a private wall', { isPublic: false, isUnlisted: false }, { wall: WALL_UUID }],
  ])('404s %s', async (_case, boardOverrides: Partial<ResolvedBoard>, searchParams: PosterSearchParams) => {
    resolveBoardBySlug.mockResolvedValue(boardFixture(boardOverrides));
    fetchSprayWallPageData.mockResolvedValue(wallData());
    await expect(renderPoster('sharma-spraywall', searchParams)).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s a wall with nothing published', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture());
    fetchSprayWallPageData.mockResolvedValue(null);
    await expect(renderPoster('sharma-spraywall')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('404s a slug that resolves to nothing', async () => {
    resolveBoardBySlug.mockResolvedValue(null);
    await expect(renderPoster('nope')).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it('308s a merged slug onto the canonical one, keeping the capability and a known layout only', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture({ slug: 'canonical-wall', isPublic: false, isUnlisted: true }));
    fetchSprayWallPageData.mockResolvedValue(wallData());
    try {
      await renderPoster('old-twin', { wall: WALL_UUID, layout: 'cards', utm_source: 'x' });
    } catch (error) {
      expect(error).toBeInstanceOf(RedirectSignal);
      expect((error as RedirectSignal).target).toBe(`/poster/b/canonical-wall?wall=${WALL_UUID}&layout=cards`);
      return;
    }
    throw new Error('expected a redirect');
  });
});

describe('board poster — LED boards', () => {
  it('prints a public board on the plain poster, with its own brand and the independence line', async () => {
    resolveBoardBySlug.mockResolvedValue(ledFixture());
    const { container } = await renderPoster('main-kilter', { layout: 'photo' });

    expect(printedQrValues()).toEqual(['https://www.boardsesh.com/b/main-kilter?src=qr&medium=board']);
    expect(screen.getByText('This board is on Boardsesh')).toBeTruthy();
    expect(container.textContent).toContain('Works with Kilter.');
    expect(container.textContent).toContain('It is not affiliated with or endorsed by Aurora Climbing');
    expect(container.textContent).not.toContain('Tension');
    expect([...layoutLinks().keys()]).toEqual(['Plain poster', 'Cards']);
    expect(fetchSprayWallPageData).not.toHaveBeenCalled();
    // An adjustable board prints no angle: it would be wrong half the time.
    expect(container.textContent).not.toContain('40°');
  });

  it('prints an unlisted board with the plain link and ignores an invite token', async () => {
    resolveBoardBySlug.mockResolvedValue(ledFixture({ isPublic: false, isUnlisted: true }));
    const { container } = await renderPoster('main-kilter', { invite: INVITE_TOKEN });

    expect(printedQrValues()).toEqual(['https://www.boardsesh.com/b/main-kilter?src=qr&medium=board']);
    expect(container.innerHTML).not.toContain(INVITE_TOKEN);
    expect(resolveBoardBySlug).toHaveBeenCalledWith('main-kilter', undefined);
  });

  it('404s a Followers, Invite-only or Only me board, even for a viewer the backend let read it', async () => {
    resolveBoardBySlug.mockResolvedValue(ledFixture({ isPublic: false, isUnlisted: false }));
    await expect(renderPoster('main-kilter', { invite: INVITE_TOKEN })).rejects.toBeInstanceOf(NotFoundSignal);
  });
});

describe('board poster metadata', () => {
  it('is noindex with no canonical or hreflang, and sends no referrer', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture());
    fetchSprayWallPageData.mockResolvedValue(wallData());
    const metadata = await generateMetadata({
      params: Promise.resolve({ board_slug: 'sharma-spraywall' }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.referrer).toBe('no-referrer');
    expect(metadata.title).toEqual({ absolute: 'QR poster for Sharma big spraywall | Boardsesh' });
    // The board poster's own line, not the gym poster's: it names neither the
    // board nor its kind, so a refused request can carry the same one.
    expect(metadata.description).toBe(
      'A print-ready QR code. Climbers scan it to see the climbs here and log their sends.',
    );
  });

  it('does not name a board the poster refuses, and answers it exactly like a missing one', async () => {
    resolveBoardBySlug.mockResolvedValue(boardFixture({ name: 'Secret Wall', isPublic: false, isUnlisted: true }));
    fetchSprayWallPageData.mockResolvedValue(wallData());
    const metadata = await generateMetadata({
      params: Promise.resolve({ board_slug: 'secret-wall' }),
      searchParams: Promise.resolve({}),
    });

    resolveBoardBySlug.mockResolvedValue(null);
    const missingMetadata = await generateMetadata({
      params: Promise.resolve({ board_slug: 'secret-wall' }),
      searchParams: Promise.resolve({}),
    });

    expect(JSON.stringify(metadata)).not.toContain('Secret Wall');
    expect(metadata).toEqual(missingMetadata);
  });
});
