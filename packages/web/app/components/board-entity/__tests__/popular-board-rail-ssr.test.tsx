import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import PopularBoardRail from '../popular-board-rail';

/**
 * What the crawler actually reads.
 *
 * This is the oracle for the whole item: the homepage is the strongest
 * internal-link source www has, and before this rail shipped there was not one
 * server-rendered link from `/` to any board's climbs. A jsdom render would
 * pass just as happily if someone wrapped the rail in
 * `dynamic(…, { ssr: false })` to dodge a renderer import — `renderToString`
 * would not. Mock the renderer if it ever explodes here; never mock the rail.
 */
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

function makeConfig(index: number): PopularBoardConfig {
  return {
    boardType: 'kilter',
    layoutId: 1,
    layoutName: 'Original',
    sizeId: 10,
    sizeName: '12 x 12 Square',
    sizeDescription: 'Full size',
    setIds: [1, 20],
    setNames: ['Bolt Ons', 'Screw Ons'],
    climbCount: 500 + index,
    totalAscents: 5000 + index,
    boardCount: 10 + index,
    displayName: `Popular board ${index}`,
  };
}

const TWELVE_CONFIGS = Array.from({ length: 12 }, (_, index) => makeConfig(index));

describe('PopularBoardRail server HTML', () => {
  it('emits one real anchor per config, every one of them a /list URL', () => {
    const html = renderToString(<PopularBoardRail configs={TWELVE_CONFIGS} />);

    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs).toHaveLength(12);
    for (const href of hrefs) {
      expect(href.startsWith('/')).toBe(true);
      expect(href.endsWith('/list')).toBe(true);
    }
  });

  it('renders nothing at all when the backend handed back no configs', () => {
    // getPopularBoardConfigs() returns [] on backend failure — an empty rail
    // must not leave a lone section heading behind.
    expect(renderToString(<PopularBoardRail configs={[]} />)).toBe('');
  });

  it('renders nothing when the board tables resolve none of the configs', () => {
    // The realistic case: a layout/size live in the DB before the generated
    // hold tables catch up. Every card drops inside the map, so a guard on the
    // input array would leave the heading standing over an empty grid.
    const html = renderToString(
      <PopularBoardRail configs={[{ ...makeConfig(0), layoutId: 999_999, sizeId: 999_999, setIds: [1] }]} />,
    );

    expect(html).toBe('');
  });

  it('uses displayName as the anchor text and adds no aria-label to override it', () => {
    const html = renderToString(<PopularBoardRail configs={[makeConfig(0)]} />);

    expect(html).toContain('Popular board 0');
    expect(html).not.toContain('aria-label');
    expect(html).not.toContain('title=');
  });
});
