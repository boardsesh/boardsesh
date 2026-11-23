import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { buildStoreUrl } from '@/app/lib/store-links';
import type { BetaLink } from '@/app/lib/beta-video-url';

/**
 * "What you get in the app" (A5): five benefits in the owner's order, each
 * with a real picture, the 30-day line, and the page's second store pair.
 * Rendered to a string, which is what the edge caches and a crawler reads.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

const communityStats = vi.hoisted(() => ({
  current: { climbersLast30Days: 3249, litLast30Days: 205_800 } as {
    climbersLast30Days: number;
    litLast30Days: number;
  } | null,
}));
vi.mock('@/app/lib/graphql/server-cached-client', () => ({
  cachedCommunityStats: vi.fn(async () => communityStats.current),
}));

vi.mock('@/app/lib/analytics', () => ({ track: vi.fn(), trackBeforeNavigation: vi.fn() }));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const ClimbAppShowcase = (await import('../climb-app-showcase')).default;

function betaLink(index: number, overrides: Partial<BetaLink> = {}): BetaLink {
  return {
    climb_uuid: 'CLIMB',
    link: `https://www.instagram.com/p/beta${index}/`,
    foreign_username: `filmer${index}`,
    angle: 40,
    thumbnail: `https://thumbs.example/beta${index}.jpg`,
    is_listed: true,
    created_at: '2026-11-01T00:00:00Z',
    tick_uuid: null,
    board_id: null,
    ...overrides,
  };
}

async function renderShowcase(betaLinks: BetaLink[] = []): Promise<Document> {
  const html = renderToString(<>{await resolveServerTree(<ClimbAppShowcase betaLinks={betaLinks} />)}</>);
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
}

beforeEach(() => {
  communityStats.current = { climbersLast30Days: 3249, litLast30Days: 205_800 };
});

describe('ClimbAppShowcase', () => {
  it('sells the five benefits in order, each with a heading and one sentence', async () => {
    const page = await renderShowcase();
    const cards = [...page.querySelectorAll('ul > li')];

    expect(page.querySelector('h2')?.textContent).toBe('frontDoor.app.heading');
    expect(cards.map((card) => card.querySelector('h3')?.textContent)).toEqual([
      'frontDoor.app.beta.title',
      'frontDoor.app.wall.title',
      'frontDoor.app.boards.title',
      'frontDoor.app.logbook.title',
      'frontDoor.app.workouts.title',
    ]);
    for (const card of cards) expect(card.querySelectorAll('p')).toHaveLength(1);
  });

  it('shows real app captures and the homepage poster, all lazy', async () => {
    const page = await renderShowcase();
    const shots = [...page.querySelectorAll('[data-marketing-shot]')].map((shot) =>
      shot.getAttribute('data-marketing-shot'),
    );

    expect(shots).toEqual(['wall-status', 'profile', 'workouts']);
    const images = [...page.querySelectorAll('img')];
    expect(
      images.some((image) => decodeURIComponent(image.getAttribute('src') ?? '').includes('showcase-hero-9x16')),
    ).toBe(true);
    for (const image of images) {
      expect(image.getAttribute('loading')).toBe('lazy');
      expect(image.getAttribute('width')).toBeTruthy();
      expect(image.getAttribute('height')).toBeTruthy();
    }
  });

  it("fans out up to three of this climb's beta thumbnails with their filmers' handles", async () => {
    const page = await renderShowcase([
      betaLink(1),
      betaLink(2, { thumbnail: null }),
      betaLink(3),
      betaLink(4),
      betaLink(5),
    ]);
    const fan = page.querySelector('[data-count]');

    expect(fan?.getAttribute('data-count')).toBe('3');
    expect(fan?.getAttribute('aria-hidden')).toBe('true');
    expect([...(fan?.querySelectorAll('img') ?? [])].map((image) => image.getAttribute('src'))).toEqual([
      'https://thumbs.example/beta1.jpg',
      'https://thumbs.example/beta3.jpg',
      'https://thumbs.example/beta4.jpg',
    ]);
    expect(fan?.textContent).toContain('@filmer1');
    expect(fan?.textContent).not.toContain('@filmer2');
  });

  it('shows a plain play tile when the climb has no beta thumbnails', async () => {
    const page = await renderShowcase([betaLink(1, { thumbnail: null })]);

    expect(page.querySelector('[data-count]')).toBeNull();
    expect(page.querySelector('ul > li')?.querySelector('img')).toBeNull();
    expect(page.querySelector('ul > li')?.querySelector('svg')).not.toBeNull();
  });

  it('links the logbook card to the logbook import', async () => {
    const page = await renderShowcase();
    const link = page.querySelector('a[href="/bring-your-logbook"]');

    expect(link?.textContent).toBe('frontDoor.app.logbook.link');
    expect(link?.closest('li')?.querySelector('h3')?.textContent).toBe('frontDoor.app.logbook.title');
  });

  it('quotes the 30-day line and drops it when the numbers did not load', async () => {
    const withStats = await renderShowcase();
    expect(withStats.body.textContent).toContain('home.hero.proof');

    communityStats.current = null;
    const withoutStats = await renderShowcase();
    expect(withoutStats.body.textContent).not.toContain('home.hero.proof');
    // The store pair does not wait on the numbers.
    expect(withoutStats.querySelectorAll('[data-cta="app-install"] a')).toHaveLength(2);
  });

  it('ships both stores under its own link id, marked for the sticky bar', async () => {
    const page = await renderShowcase();
    const stores = page.querySelector('[data-cta="app-install"]');

    expect([...(stores?.querySelectorAll('a') ?? [])].map((link) => link.getAttribute('href'))).toEqual([
      buildStoreUrl('ios', { placement: 'climb-app-module' }),
      buildStoreUrl('android', { placement: 'climb-app-module' }),
    ]);
    expect(stores?.hasAttribute('data-sticky-install-hide')).toBe(true);
  });
});

describe('the app module copy', () => {
  const app = enClimbs.frontDoor.app;

  it('names the boards it works with, never "one app for" one of them', () => {
    expect(app.boards.body).toContain('Works with Kilter, Tension, MoonBoard and more.');
    expect(app.boards.body).not.toMatch(/app for (Kilter|Tension|MoonBoard)/);
  });

  it('has no em dashes', () => {
    const strings = JSON.stringify(app);
    expect(strings).not.toContain('—');
  });
});
