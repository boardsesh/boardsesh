import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import ClimbCreativeWorkJsonLd from '@/app/components/climb-front-door/climb-creative-work-json-ld';
import ClimbListJsonLd from '@/app/components/climb-front-door/climb-list-json-ld';
import ProfileJsonLd from '@/app/profile/[user_id]/profile-json-ld';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import { absoluteUrl } from '@/app/lib/seo/base-url';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { Locale } from '@/app/lib/i18n/config';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: (key: string) => key, locale: 'en-US' })),
}));

const SiteJsonLd = (await import('@/app/components/seo/site-json-ld')).default;

const BOARD_DETAILS = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  layout_name: 'Kilter Board Original',
  size_name: '12 x 12',
  size_description: 'Commercial',
  set_names: ['Bolt Ons', 'Screw Ons'],
} as unknown as BoardDetails;

const CLIMB_UUID = 'abcdef1234567890abcdef1234567890';

function climb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: CLIMB_UUID,
    name: 'Test Climb',
    setter_username: 'setterperson',
    angle: 40,
    difficulty: 'V5',
    quality_average: '4.20',
    ascensionist_count: 42,
    frames: 'p1r12',
    created_at: '2025-02-03T04:05:06.000Z',
    published_at: null,
    ...overrides,
  } as unknown as Climb;
}

function stats(overrides: Partial<ClimbStatsForAngle> = {}): ClimbStatsForAngle {
  return {
    angle: 40,
    ascensionist_count: '42',
    quality_average: '4.20',
    difficulty_average: 18,
    display_difficulty: 18,
    fa_username: null,
    fa_at: null,
    difficulty: 'V5',
    quality_normalized: true,
    rating_count: '17',
    ...overrides,
  };
}

/** The single JSON-LD payload an element renders, parsed. */
function payload(element: React.ReactElement): Record<string, unknown> {
  const html = renderToString(element);
  const matches = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one JSON-LD payload, found ${matches.length}: ${html}`);
  }

  return JSON.parse(matches[0][1].replace(/\\u003c/g, '<')) as Record<string, unknown>;
}

const CANONICAL = buildCanonicalClimbViewUrl(BOARD_DETAILS, 40, CLIMB_UUID, 'Test Climb');

function creativeWork(
  overrides: {
    climb?: Climb;
    currentAngleStats?: ClimbStatsForAngle | undefined;
    description?: string | null;
    overlayUrl?: string | null;
    locale?: Locale;
  } = {},
) {
  return payload(
    <ClimbCreativeWorkJsonLd
      climb={overrides.climb ?? climb()}
      climbName="Test Climb"
      canonicalClimbUrl={CANONICAL}
      overlayUrl={overrides.overlayUrl === undefined ? '/api/internal/board-render?x=1' : overrides.overlayUrl}
      currentAngleStats={'currentAngleStats' in overrides ? overrides.currentAngleStats : stats()}
      description={overrides.description === undefined ? 'a climb' : overrides.description}
      locale={overrides.locale ?? 'en-US'}
    />,
  );
}

describe('CreativeWork JSON-LD', () => {
  it('names the page canonical, not the hand-off path', () => {
    const data = creativeWork();

    expect(data['@type']).toBe('CreativeWork');
    expect(data.url).toBe(absoluteUrl(CANONICAL));
    expect(data.name).toBe('Test Climb');
    expect(data.author).toEqual({ '@type': 'Person', name: 'setterperson' });
    expect(data.image).toBe('https://www.boardsesh.com/api/internal/board-render?x=1');
    expect(data.dateCreated).toBe('2025-02-03T04:05:06.000Z');
  });

  it('preserves an absolute Railway board image URL', () => {
    const data = creativeWork({ overlayUrl: 'https://ws.boardsesh.com/render/board?x=1' });

    expect(data.image).toBe('https://ws.boardsesh.com/render/board?x=1');
  });

  it('omits fields it cannot source instead of inventing them', () => {
    const data = creativeWork({
      climb: { ...climb(), setter_username: '  ', created_at: 'not-a-date', published_at: null } as Climb,
      description: null,
      overlayUrl: null,
    });

    expect(data).not.toHaveProperty('author');
    expect(data).not.toHaveProperty('dateCreated');
    expect(data).not.toHaveProperty('description');
    expect(data).not.toHaveProperty('image');
  });

  it('emits aggregateRating when the average is normalised and the blend has a denominator', () => {
    const data = creativeWork();

    expect(data.aggregateRating).toEqual({
      '@type': 'AggregateRating',
      ratingValue: 4.2,
      // The blend's own count — NOT ascensionist_count (42). Ascents are not ratings.
      ratingCount: 17,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it('omits aggregateRating when quality_average is still on the raw 1-3 scale', () => {
    // ~235k JSON-imported Kilter rows are unnormalized; publishing 2.4/5 for a
    // climb rated 2.4/3 understates every one of them.
    expect(creativeWork({ currentAngleStats: stats({ quality_normalized: false }) })).not.toHaveProperty(
      'aggregateRating',
    );
  });

  it('omits aggregateRating when there is no quality average at all', () => {
    expect(creativeWork({ currentAngleStats: stats({ quality_average: null }) })).not.toHaveProperty('aggregateRating');
  });

  it('omits aggregateRating when the rating count is zero', () => {
    expect(creativeWork({ currentAngleStats: stats({ rating_count: '0' }) })).not.toHaveProperty('aggregateRating');
  });

  it('omits aggregateRating when the angle has no stats row', () => {
    expect(creativeWork({ currentAngleStats: undefined })).not.toHaveProperty('aggregateRating');
  });

  it('emits the rating count the blend actually has, upstream-only rows included', () => {
    // The production shape, not a hand-picked split: Aurora supplied a quality,
    // Boardsesh has no native ratings yet. `rating_count` is then the upstream
    // ascent population Aurora averaged over — which IS its rating count, and is
    // still not `ascensionist_count` (the blended total, 4,850 here). The claim
    // this pins is narrow and true: the count is the quality blend's own
    // denominator, never the ascent total.
    const data = creativeWork({
      climb: { ...climb(), ascensionist_count: 4850 } as Climb,
      currentAngleStats: stats({ rating_count: '4800', ascensionist_count: '4850', quality_average: '3.10' }),
    });

    expect((data.aggregateRating as Record<string, unknown>).ratingCount).toBe(4800);
    expect((data.aggregateRating as Record<string, unknown>).ratingCount).not.toBe(4850);
  });

  it('names the URL on THIS locale, matching the page canonical beside it', () => {
    // `createPageMetadata` runs the canonical through `localeHref`, so an /es
    // page canonicalises to the /es URL. Structured data naming the en-US URL on
    // that page contradicts the canonical it sits next to.
    expect(creativeWork({ locale: 'es' }).url).toBe(`https://www.boardsesh.com/es${CANONICAL}`);
    expect(creativeWork({ locale: 'de' }).url).toBe(`https://www.boardsesh.com/de${CANONICAL}`);
    expect(creativeWork().url).toBe(absoluteUrl(CANONICAL));
  });

  it('ships no VideoObject', () => {
    expect(JSON.stringify(creativeWork())).not.toContain('VideoObject');
  });
});

describe('Organization / WebSite JSON-LD', () => {
  it('emits exactly Organization and WebSite in one graph', async () => {
    const data = payload(await SiteJsonLd());
    const graph = data['@graph'] as Array<Record<string, unknown>>;

    expect(graph.map((node) => node['@type'])).toEqual(['Organization', 'WebSite']);
    expect(graph[0].url).toBe('https://www.boardsesh.com');
    expect(graph[0].logo).toBe('https://www.boardsesh.com/brand/boardsesh-mark.png');
    expect(graph[0].sameAs).toEqual(['https://github.com/marcodejongh/boardsesh', 'https://discord.gg/YXA8GsXfQK']);
    expect(graph[1].inLanguage).toBe('en-US');
  });

  it('declares no SearchAction anywhere in the graph', async () => {
    // www has no site search after the W-16 teardown; a potentialAction pointing
    // at a non-existent endpoint is a fabricated capability. Deep scan of the
    // stringified graph so nesting cannot hide one.
    const serialised = JSON.stringify(payload(await SiteJsonLd()));

    expect(serialised).not.toContain('potentialAction');
    expect(serialised).not.toContain('SearchAction');
    expect(serialised).not.toContain('search_term_string');
  });
});

describe('ItemList JSON-LD', () => {
  const climbs = [
    { ...climb(), uuid: 'aaaa1111aaaa1111aaaa1111aaaa1111', name: 'First' },
    { ...climb(), uuid: 'bbbb2222bbbb2222bbbb2222bbbb2222', name: null },
  ] as Climb[];

  it('numbers positions globally so page 2 does not restart at 1', () => {
    const first = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} locale="en-US" />);
    const second = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={2} locale="en-US" />);

    const positions = (list: Record<string, unknown>) =>
      (list.itemListElement as Array<Record<string, unknown>>).map((item) => item.position);

    expect(positions(first)).toEqual([1, 2]);
    expect(positions(second)).toEqual([51, 52]);
    expect(first.numberOfItems).toBe(2);
  });

  it('advertises exactly the URLs the rows link to, unnamed climbs included', () => {
    // This is what pins the static-climb-row fix: the row anchor, the page
    // canonical and this url are one string, or a climb has three URLs.
    const data = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} locale="en-US" />);
    const urls = (data.itemListElement as Array<Record<string, unknown>>).map((item) => item.url);

    expect(urls).toEqual(
      climbs.map((entry) =>
        absoluteUrl(
          buildCanonicalClimbViewUrl(
            BOARD_DETAILS,
            entry.angle,
            entry.uuid,
            resolveClimbDisplayName(entry.name, BOARD_DETAILS.board_name),
          ),
        ),
      ),
    );
    expect(urls[1]).toContain('kilter-climb-');
  });

  it('prefixes every url with the rendering locale', () => {
    const data = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} locale="fr" />);
    const urls = (data.itemListElement as Array<Record<string, unknown>>).map((item) => item.url as string);

    expect(urls.every((url) => url.startsWith('https://www.boardsesh.com/fr/'))).toBe(true);
  });

  it('renders nothing for an empty page', () => {
    expect(renderToString(<ClimbListJsonLd climbs={[]} boardDetails={BOARD_DETAILS} page={1} locale="en-US" />)).toBe(
      '',
    );
  });
});

describe('ProfilePage JSON-LD', () => {
  it('names the person and the profile canonical', () => {
    const data = payload(<ProfileJsonLd userId="marco de jongh" displayName="Marco" locale="en-US" />);

    expect(data['@type']).toBe('ProfilePage');
    expect(data.url).toBe('https://www.boardsesh.com/profile/marco%20de%20jongh');
    expect(data.mainEntity).toEqual({
      '@type': 'Person',
      name: 'Marco',
      url: 'https://www.boardsesh.com/profile/marco%20de%20jongh',
    });
  });

  it('emits nothing when there is no name to claim', () => {
    // The notFound() and catch branches are both `noindex, follow`; structured
    // data there would describe a page we are asking Google to skip.
    expect(renderToString(<ProfileJsonLd userId="ghost" displayName={null} locale="en-US" />)).toBe('');
  });

  it('prefixes the profile url with the rendering locale', () => {
    const data = payload(<ProfileJsonLd userId="marco" displayName="Marco" locale="es" />);

    expect(data.url).toBe('https://www.boardsesh.com/es/profile/marco');
    expect((data.mainEntity as Record<string, unknown>).url).toBe('https://www.boardsesh.com/es/profile/marco');
  });

  it('leaks no email or counts', () => {
    const serialised = JSON.stringify(payload(<ProfileJsonLd userId="marco" displayName="Marco" locale="en-US" />));
    expect(serialised).not.toContain('email');
    expect(serialised).not.toContain('interactionStatistic');
  });
});

describe('the deferred work stays deferred', () => {
  it('ships no VideoObject in any JSON-LD payload', async () => {
    // Beta links are third-party embeds and need a policy call first. Cheap,
    // machine-checkable, and it fails the day someone adds one.
    const payloads = [
      JSON.stringify(creativeWork()),
      JSON.stringify(payload(await SiteJsonLd())),
      JSON.stringify(
        payload(<ClimbListJsonLd climbs={[climb()]} boardDetails={BOARD_DETAILS} page={1} locale="en-US" />),
      ),
      JSON.stringify(payload(<ProfileJsonLd userId="marco" displayName="Marco" locale="en-US" />)),
    ];

    for (const serialised of payloads) {
      expect(serialised).not.toContain('VideoObject');
      expect(serialised).not.toContain('embedUrl');
    }
  });
});

describe('the escaping helper', () => {
  it('escapes `<` so user content cannot close the script block', () => {
    const html = renderToString(<ProfileJsonLd userId="x" displayName={'</script><img src=x>'} locale="en-US" />);

    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script');
  });
});
