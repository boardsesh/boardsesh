import type { Metadata } from 'next';
import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * The surfaces W-22 routes through `createPageMetadata` all used to hand-roll
 * `alternates.canonical` with no `languages`, which is exactly the Search
 * Console "no return links" failure. Each case runs under `en-US` **and** `es`:
 * a call site that forgot to thread `locale` still looks right in English and
 * silently cross-canonicalises the Spanish tree onto its English twin.
 */

const requestLocale = vi.hoisted(() => ({ value: '' }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(requestLocale.value ? { 'x-boardsesh-locale': requestLocale.value } : {}),
}));

// The setter page now imports its own Drizzle data layer, which constructs a
// pool at module scope. Metadata never reads it — stub the module so importing
// the page does not need DATABASE_URL.
vi.mock('@/app/lib/db/db', () => ({ dbz: {}, dbzRead: {}, sql: {}, executeRows: async () => [] }));

vi.mock('@/app/lib/seo/dynamic-og-data', () => ({
  getSetterOgSummary: async () => ({ displayName: 'Marco', avatarUrl: null, version: 'v1' }),
  getProfileOgSummary: async () => ({
    displayName: 'Marco',
    avatarUrl: null,
    fallbackImageUrl: null,
    topBoardType: 'kilter',
    version: 'v1',
  }),
  getPlaylistOgSummary: async () => ({
    name: 'Crimp Ladder',
    description: null,
    color: null,
    icon: null,
    isPublic: true,
    boardType: 'kilter',
    climbCount: 12,
    version: 'v1',
  }),
  getSessionOgSummary: async () => ({
    sessionType: 'party',
    sessionName: 'Tuesday Sesh',
    leaderName: 'Marco',
    participantNames: ['Marco'],
    participantCount: 1,
    totalSends: 3,
    gradeRows: [],
    boardLabel: null,
    boardAngle: null,
    boardPreviewPath: null,
    version: 'v1',
    found: true,
  }),
}));

vi.mock('@/app/components/providers/i18n-provider', () => ({
  default: ({ children }: { children: unknown }) => children,
}));
vi.mock('../session/[sessionId]/session-detail-content', () => ({ default: () => null }));

const setterPage = await import('../setter/[setter_username]/page');
const sessionPage = await import('../session/[sessionId]/page');
const { generatePlaylistMetadata } = await import('../lib/seo/playlist-metadata');

type MetadataCase = {
  name: string;
  basePath: string;
  load: (locale: 'en-US' | 'es') => Promise<Metadata>;
};

async function withLocale<T>(locale: 'en-US' | 'es', run: () => Promise<T>): Promise<T> {
  requestLocale.value = locale === 'en-US' ? '' : locale;
  try {
    return await run();
  } finally {
    requestLocale.value = '';
  }
}

const cases: MetadataCase[] = [
  {
    name: 'playlist detail',
    basePath: '/playlists/abc-123',
    load: (locale) => withLocale(locale, () => generatePlaylistMetadata('abc-123', locale)),
  },
  {
    name: 'session share page',
    basePath: '/session/session-1',
    load: (locale) =>
      withLocale(locale, () => sessionPage.generateMetadata({ params: Promise.resolve({ sessionId: 'session-1' }) })),
  },
];

describe('hreflang returns for every sitemapped surface', () => {
  for (const testCase of cases) {
    it(`${testCase.name} canonicalises per locale and advertises all five alternates`, async () => {
      const expectedLanguages = {
        'en-US': testCase.basePath,
        es: `/es${testCase.basePath}`,
        fr: `/fr${testCase.basePath}`,
        de: `/de${testCase.basePath}`,
        'x-default': testCase.basePath,
      };

      const english = await testCase.load('en-US');
      expect(english.alternates?.canonical).toBe(testCase.basePath);
      expect(english.alternates?.languages).toEqual(expectedLanguages);

      const spanish = await testCase.load('es');
      expect(spanish.alternates?.canonical).toBe(`/es${testCase.basePath}`);
      expect(spanish.alternates?.languages).toEqual(expectedLanguages);
    });
  }
});

/**
 * Board content is the deliberate exception to everything above.
 *
 * `/setter/marco` used to sit in the table above. It moved here — not because
 * the rule above got weaker, but because these pages are a different kind of
 * thing: the locale twins are translated *chrome* over *identical* content. The
 * climb name, grade, setter and board art are the same in every locale; only UI
 * strings differ. Four URLs for one page cost a 4x crawl surface, measured at
 * ~205k climb-view renders/day with Postgres at 183/200 connections.
 *
 * So these cross-canonicalise onto the default locale and emit NO `languages`,
 * via `createBoardContentPageMetadata`. Both halves are required: canonical
 * alone leaves the twins advertised by their own hreflang block, and Google
 * requires hreflang cluster members to self-canonicalise, so the pair would be
 * contradictory.
 *
 * Everything still in `cases` above keeps the W-22 rule, and that is correct —
 * `/about`, `/legal`, `/docs`, playlists and session shares are real translated
 * content or genuinely per-locale surfaces. This is a carve-out with a reason,
 * not the start of a drift.
 */
describe('board content cross-canonicalises instead', () => {
  it('setter profile points every locale at the English URL and advertises no alternates', async () => {
    const basePath = '/setter/marco';
    const load = (locale: 'en-US' | 'es') =>
      withLocale(locale, () =>
        setterPage.generateMetadata({
          params: Promise.resolve({ setter_username: 'marco' }),
          searchParams: Promise.resolve({}),
        }),
      );

    const english = await load('en-US');
    expect(english.alternates?.canonical).toBe(basePath);
    expect(english.alternates?.languages).toBeUndefined();

    // The point of the change: the Spanish twin does NOT self-canonicalise.
    const spanish = await load('es');
    expect(spanish.alternates?.canonical).toBe(basePath);
    expect(spanish.alternates?.languages).toBeUndefined();
  });
});
