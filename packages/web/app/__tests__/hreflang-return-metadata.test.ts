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
vi.mock('../setter/[setter_username]/setter-profile-content', () => ({ default: () => null }));
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
    name: 'setter profile',
    basePath: '/setter/marco',
    load: (locale) =>
      withLocale(locale, () => setterPage.generateMetadata({ params: Promise.resolve({ setter_username: 'marco' }) })),
  },
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
