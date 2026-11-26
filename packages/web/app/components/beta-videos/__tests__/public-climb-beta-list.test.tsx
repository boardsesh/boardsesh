import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import type { BetaLink } from '@/app/lib/beta-video-url';
import PublicClimbBetaList from '../public-climb-beta-list';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

function betaLinks(count: number): BetaLink[] {
  return Array.from({ length: count }, (_, index) => ({
    link: `https://www.instagram.com/p/film-${index}/`,
    climb_uuid: 'public-climb',
    foreign_username: `filmer-${index}`,
    thumbnail: index % 2 === 0 ? `https://media.example/film-${index}.jpg` : null,
  })) as BetaLink[];
}

describe('public beta previews without app providers', () => {
  it('renders video destinations and credits in the first HTML', async () => {
    const html = renderToString(await PublicClimbBetaList({ links: betaLinks(3) }));
    expect(html.match(/href="https:\/\/www.instagram.com\/p\/film-/g)).toHaveLength(3);
    expect(html).toContain('@filmer-0');
    expect(html).toContain('rel="ugc nofollow noopener noreferrer"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('<details');
  });

  it('keeps the remaining video links in a native disclosure that works without JavaScript', async () => {
    const html = renderToString(await PublicClimbBetaList({ links: betaLinks(8) }));
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(document.querySelector('details > summary')?.textContent).toBe('betaVideos.showAll');
    expect(document.querySelectorAll('details a')).toHaveLength(2);
    expect(document.querySelectorAll('a')).toHaveLength(8);
    expect(document.querySelector('details a')?.getAttribute('href')).toBe('https://www.instagram.com/p/film-6/');
  });

  it('keeps videos without a stored thumbnail as playable links', async () => {
    const html = renderToString(await PublicClimbBetaList({ links: [betaLinks(2)[1]] }));
    expect(html).toContain('href="https://www.instagram.com/p/film-1/"');
    expect(html).toContain('betaVideos.watch');
    expect(html).not.toContain('<img');
  });
});
