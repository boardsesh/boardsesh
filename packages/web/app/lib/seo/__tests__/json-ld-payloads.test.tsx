import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import ClimbCreativeWorkJsonLd from '@/app/components/climb-front-door/climb-creative-work-json-ld';
import { buildOgBoardRenderUrl } from '@/app/components/board-renderer/util';
import { buildOgClimbCardIdentity } from '@/app/lib/seo/og-climb-identity';
import type { BoardImageDetails } from '@/app/lib/board-image-details';
import ClimbListJsonLd from '@/app/components/climb-front-door/climb-list-json-ld';
import ProfileJsonLd from '@/app/profile/[user_id]/profile-json-ld';
import SetterJsonLd from '@/app/setter/[setter_username]/setter-json-ld';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import { absoluteUrl, SITE_URL } from '@/app/lib/seo/base-url';
import { createBoardContentPageMetadata } from '@/app/lib/seo/metadata';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardDetails, Climb } from '@/app/lib/types';

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
    angleStats?: ClimbStatsForAngle[];
  } = {},
) {
  return payload(
    <ClimbCreativeWorkJsonLd
      climb={overrides.climb ?? climb()}
      climbName="Test Climb"
      canonicalClimbUrl={CANONICAL}
      boardDetails={BOARD_DETAILS as unknown as BoardImageDetails}
      canonicalAngle={40}
      angleStats={overrides.angleStats ?? [stats()]}
      description="a climb"
    />,
  );
}

describe('CreativeWork JSON-LD', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('names the page canonical, not the hand-off path', () => {
    const data = creativeWork();

    expect(data['@type']).toBe('CreativeWork');
    expect(data.url).toBe(absoluteUrl(CANONICAL));
    expect(data.name).toBe('Test Climb');
    expect(data.dateCreated).toBe('2025-02-03T04:05:06.000Z');
  });

  it("links the author to the setter's page, locale-free like the url beside it", () => {
    expect(creativeWork().author).toEqual({
      '@type': 'Person',
      name: 'setterperson',
      url: 'https://www.boardsesh.com/setter/setterperson',
    });
  });

  it('encodes a setter name the same way the front door setter link does', () => {
    const data = creativeWork({ climb: { ...climb(), setter_username: 'Jo & Ann 50%' } as Climb });

    expect(data.author).toEqual({
      '@type': 'Person',
      name: 'Jo & Ann 50%',
      url: 'https://www.boardsesh.com/setter/Jo%20%26%20Ann%2050%25',
    });
  });

  it.each([
    ' Jo & Ann ',
    'Jo/Ann',
    'Jo?Ann',
    `Jo${String.fromCharCode(0x07)}Ann`,
    `Jo${String.fromCharCode(0xa0)}Ann`,
    '..',
  ])('names the setter but links no page for %j, which the setter sitemap rejects too', (setterUsername) => {
    const author = creativeWork({ climb: { ...climb(), setter_username: setterUsername } as Climb }).author;

    expect(author).toEqual({ '@type': 'Person', name: setterUsername.trim() });
  });

  it("uses the climb's share card at the canonical angle, not the bare holds render", () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
    const data = creativeWork();

    // The very URL `generateMetadata` puts in `og:image`, from the same two builders.
    expect(data.image).toBe(
      buildOgBoardRenderUrl(BOARD_DETAILS, 'p1r12', buildOgClimbCardIdentity(climb(), 'kilter', 40, [stats()])),
    );
    const image = new URL(String(data.image));
    expect(`${image.origin}${image.pathname}`).toBe('https://ws.boardsesh.com/og/climb');
    expect(image.searchParams.get('angle')).toBe('40');
    expect(image.searchParams.get('n')).toBe('Test Climb');
    expect(image.searchParams.get('s')).toBe('setterperson');
  });

  it('prints the canonical angle grade on the card, not the requested angle grade', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
    // `climb.difficulty` is the grade at the angle being viewed; the card is
    // keyed on the canonical angle and must print that angle's grade.
    const data = creativeWork({
      climb: { ...climb(), difficulty: 'V1' } as Climb,
      angleStats: [stats({ angle: 40, display_difficulty: 18 })],
    });

    const cardGrade = new URL(String(data.image)).searchParams.get('g');
    expect(cardGrade).not.toBe('V1');
    expect(cardGrade).toBe(buildOgClimbCardIdentity(climb(), 'kilter', 40, [stats({ display_difficulty: 18 })]).grade);
  });

  it('resolves the same-origin card path when no backend origin is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_WS_URL', '');
    const image = String(creativeWork().image);

    expect(image.startsWith(`${SITE_URL}/`)).toBe(true);
  });

  it('omits fields it cannot source instead of inventing them', () => {
    const data = creativeWork({
      climb: { ...climb(), setter_username: '  ', created_at: 'not-a-date', published_at: null, frames: '' } as Climb,
    });

    expect(data).not.toHaveProperty('author');
    expect(data).not.toHaveProperty('dateCreated');
    expect(data).not.toHaveProperty('image');
  });

  it('ships no aggregateRating, even for a normalised, well-rated climb', () => {
    // Google shows no review snippet for CreativeWork, and the rating count
    // blends in Aurora's upstream ratings, which its review rules forbid.
    const data = creativeWork({ angleStats: [stats({ quality_average: '4.80', rating_count: '400' })] });

    expect(data).not.toHaveProperty('aggregateRating');
    expect(JSON.stringify(data)).not.toContain('AggregateRating');
  });

  it('names the same URL the page canonical does, on every locale', () => {
    // Climb pages go through `createBoardContentPageMetadata`, NOT
    // `createPageMetadata`: it pins the canonical to the DEFAULT-locale URL and
    // drops `alternates.languages` entirely. So a locale-prefixed `url` here
    // would advertise an address the canonical beside it disowns — which is what
    // this test used to assert was correct. Comparing against the helper itself
    // keeps the two from drifting apart again.
    //
    // The component takes no locale any more, so `creativeWork()` is the same
    // call each time round: what the loop varies is the locale handed to the
    // METADATA helper, pinning the invariant that its canonical stays on the
    // default locale no matter which twin is rendering.
    for (const locale of ['en-US', 'es', 'de'] as const) {
      const canonical = createBoardContentPageMetadata({
        title: 'Test Climb',
        description: 'a climb',
        path: CANONICAL,
        locale,
      }).alternates?.canonical;

      expect(`${SITE_URL}${canonical}`).toBe(absoluteUrl(CANONICAL));
      expect(creativeWork().url).toBe(`${SITE_URL}${canonical}`);
    }
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
    expect(graph[0].logo).toBe('https://www.boardsesh.com/brand/boardsesh-mark.webp');
    expect(graph[0].sameAs).toEqual(['https://github.com/marcodejongh/boardsesh', 'https://discord.gg/YXA8GsXfQK']);
    // The app guides point at these same ids.
    expect(graph[0]['@id']).toBe('https://www.boardsesh.com/#organization');
    expect(graph[1]['@id']).toBe('https://www.boardsesh.com/#website');
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
    const first = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} />);
    const second = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={2} />);

    const positions = (list: Record<string, unknown>) =>
      (list.itemListElement as Array<Record<string, unknown>>).map((item) => item.position);

    expect(positions(first)).toEqual([1, 2]);
    expect(positions(second)).toEqual([51, 52]);
    expect(first.numberOfItems).toBe(2);
  });

  it('advertises exactly the URLs the rows link to, unnamed climbs included', () => {
    // This is what pins the static-climb-row fix: the row anchor, the page
    // canonical and this url are one string, or a climb has three URLs.
    const data = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} />);
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

  it('carries no locale prefix on any url, matching the list page canonical', () => {
    // `/list` is board content too: `createBoardContentPageMetadata` canonicalises
    // every locale twin to the default-locale URL, so a `/fr` prefix here would
    // name URLs the canonical disowns.
    const data = payload(<ClimbListJsonLd climbs={climbs} boardDetails={BOARD_DETAILS} page={1} />);
    const urls = (data.itemListElement as Array<Record<string, unknown>>).map((item) => item.url as string);

    expect(urls.every((url) => url.startsWith('https://www.boardsesh.com/kilter/'))).toBe(true);
  });

  it('renders nothing for an empty page', () => {
    expect(renderToString(<ClimbListJsonLd climbs={[]} boardDetails={BOARD_DETAILS} page={1} />)).toBe('');
  });
});

describe('setter ProfilePage + ItemList JSON-LD', () => {
  const setterClimbs = [
    { ...climb(), uuid: 'cccc3333cccc3333cccc3333cccc3333', name: 'Crimp Ladder' },
    { ...climb(), uuid: 'dddd4444dddd4444dddd4444dddd4444', name: 'Sloper Traverse' },
  ] as Climb[];

  const boardDetailsByClimb = Object.fromEntries(setterClimbs.map((entry) => [entry.uuid, BOARD_DETAILS]));

  function setterGraph(page = 1, unlinked: ReadonlySet<string> = new Set()) {
    const data = payload(
      <SetterJsonLd
        username="setterperson"
        displayName="Setter Person"
        climbs={setterClimbs}
        boardDetailsByClimb={boardDetailsByClimb}
        unlinkedClimbUuids={unlinked}
        page={page}
      />,
    );

    return data['@graph'] as Array<Record<string, unknown>>;
  }

  it('carries no locale prefix on any url in the graph', () => {
    // Setter pages are board content: `createBoardContentPageMetadata` pins the
    // canonical to the default-locale URL and ships no `alternates.languages`, so
    // a `/de` prefix anywhere in here would name an address that canonical
    // disowns. Deep scan, so a nested ListItem cannot smuggle one in.
    const serialised = JSON.stringify(setterGraph());

    for (const prefix of ['boardsesh.com/es/', 'boardsesh.com/fr/', 'boardsesh.com/de/']) {
      expect(serialised).not.toContain(prefix);
    }
  });

  it('names the profile and the page, and numbers items globally', () => {
    const [profilePage, itemList] = setterGraph(2);

    expect(profilePage['@id']).toBe('https://www.boardsesh.com/setter/setterperson?page=2');
    expect((profilePage.mainEntity as Record<string, unknown>).url).toBe(
      'https://www.boardsesh.com/setter/setterperson',
    );
    expect(itemList.url).toBe('https://www.boardsesh.com/setter/setterperson?page=2');
    expect((itemList.itemListElement as Array<Record<string, unknown>>).map((item) => item.position)).toEqual([51, 52]);
  });

  it.each([1, 2])('keeps the Person as the only main entity on page %i', (page) => {
    const graph = setterGraph(page);
    const profilePage = graph.find((node) => node['@type'] === 'ProfilePage')!;

    expect(profilePage.mainEntity).toEqual({
      '@type': 'Person',
      name: 'Setter Person',
      url: 'https://www.boardsesh.com/setter/setterperson',
    });
    // mainEntityOfPage is the inverse of mainEntity. An ItemList pointing
    // back at this ProfilePage gives it a second, invalid main-entity type.
    expect(graph.filter((node) => node.mainEntityOfPage)).toEqual([]);
    expect(graph.map((node) => node['@type'])).toEqual(['ProfilePage', 'ItemList']);
  });

  it.each(['empty', 'unlinked', 'unresolved'] as const)(
    'keeps a valid Person profile when the climb list is %s',
    (listState) => {
      const graph = payload(
        <SetterJsonLd
          username="Jo & Ann"
          displayName="Jo & Ann"
          climbs={listState === 'empty' ? [] : setterClimbs}
          boardDetailsByClimb={listState === 'unresolved' ? {} : boardDetailsByClimb}
          unlinkedClimbUuids={listState === 'unlinked' ? new Set(setterClimbs.map((entry) => entry.uuid)) : new Set()}
          page={1}
        />,
      )['@graph'];

      expect(graph).toEqual([
        {
          '@type': 'ProfilePage',
          '@id': 'https://www.boardsesh.com/setter/Jo%20%26%20Ann',
          url: 'https://www.boardsesh.com/setter/Jo%20%26%20Ann',
          mainEntity: {
            '@type': 'Person',
            name: 'Jo & Ann',
            url: 'https://www.boardsesh.com/setter/Jo%20%26%20Ann',
          },
        },
      ]);
    },
  );

  it('advertises exactly the URLs the rows link to, omitting the unlinked ones', () => {
    const [, itemList] = setterGraph(1, new Set([setterClimbs[1].uuid]));
    const urls = (itemList.itemListElement as Array<Record<string, unknown>>).map((item) => item.url);

    expect(urls).toEqual([
      absoluteUrl(
        buildCanonicalClimbViewUrl(
          BOARD_DETAILS,
          setterClimbs[0].angle,
          setterClimbs[0].uuid,
          resolveClimbDisplayName(setterClimbs[0].name, BOARD_DETAILS.board_name),
        ),
      ),
    ]);
    expect(itemList.numberOfItems).toBe(1);
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
      JSON.stringify(payload(<ClimbListJsonLd climbs={[climb()]} boardDetails={BOARD_DETAILS} page={1} />)),
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
