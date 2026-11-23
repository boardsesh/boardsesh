import { describe, expect, it } from 'vite-plus/test';
import { createInstance, type TFunction } from 'i18next';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import esClimbs from '@boardsesh/i18n/locales/es/climbs.json';
import frClimbs from '@boardsesh/i18n/locales/fr/climbs.json';
import deClimbs from '@boardsesh/i18n/locales/de/climbs.json';
import itClimbs from '@boardsesh/i18n/locales/it/climbs.json';
import zhClimbs from '@boardsesh/i18n/locales/zh-CN/climbs.json';
import enProfile from '@boardsesh/i18n/locales/en-US/profile.json';
import esProfile from '@boardsesh/i18n/locales/es/profile.json';
import frProfile from '@boardsesh/i18n/locales/fr/profile.json';
import deProfile from '@boardsesh/i18n/locales/de/profile.json';
import itProfile from '@boardsesh/i18n/locales/it/profile.json';
import zhProfile from '@boardsesh/i18n/locales/zh-CN/profile.json';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import {
  buildClimbSearchDescription,
  buildSetterSearchCopy,
  climbQualityRating,
  joinDescriptionSentences,
} from '../search-description';

const CATALOGS = {
  'en-US': { climbs: enClimbs, profile: enProfile },
  es: { climbs: esClimbs, profile: esProfile },
  fr: { climbs: frClimbs, profile: frProfile },
  de: { climbs: deClimbs, profile: deProfile },
  it: { climbs: itClimbs, profile: itProfile },
  'zh-CN': { climbs: zhClimbs, profile: zhProfile },
} as const;

type CatalogLocale = keyof typeof CATALOGS;
const LOCALES = Object.keys(CATALOGS) as CatalogLocale[];

/** A real i18next `t` over the shipped catalogs, so the assertions read the copy a crawler gets. */
async function translatorFor(locale: CatalogLocale, namespace: 'climbs' | 'profile'): Promise<TFunction> {
  const instance = createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: 'en-US',
    ns: [namespace],
    defaultNS: namespace,
    resources: { [locale]: CATALOGS[locale], 'en-US': CATALOGS['en-US'] },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance.t;
}

function angleStats(overrides: Partial<ClimbStatsForAngle> = {}): ClimbStatsForAngle {
  return {
    angle: 40,
    ascensionist_count: '12',
    quality_average: '4.20',
    difficulty_average: 20,
    display_difficulty: 20,
    fa_username: null,
    fa_at: null,
    difficulty: 'V5',
    quality_normalized: true,
    rating_count: '9',
    ...overrides,
  };
}

async function climbDescription(
  overrides: Partial<Parameters<typeof buildClimbSearchDescription>[0]> = {},
  locale: CatalogLocale = 'en-US',
) {
  return buildClimbSearchDescription({
    t: await translatorFor(locale, 'climbs'),
    locale,
    climbName: 'Swooped',
    grade: 'V5 (6c)',
    layoutName: 'Kilter Board Original',
    angle: 40,
    setter: 'BKBChicago',
    ascents: 12,
    angleStats: angleStats(),
    ...overrides,
  });
}

describe('climbQualityRating', () => {
  it('vouches for a normalised average with at least one rating behind it', () => {
    expect(climbQualityRating(angleStats())).toBe(4.2);
  });

  it.each([
    ['no stats row', undefined],
    ['an Aurora-scale (1-3) average', angleStats({ quality_normalized: false })],
    ['no average', angleStats({ quality_average: null })],
    ['an average below the scale', angleStats({ quality_average: '0' })],
    ['an average above the scale', angleStats({ quality_average: '5.5' })],
    ['no ratings behind the average', angleStats({ rating_count: '0' })],
  ])('refuses %s', (_label, stats) => {
    expect(climbQualityRating(stats)).toBeNull();
  });
});

describe('climb search description', () => {
  it('states the setter, the sends and the rating when all three are real', async () => {
    expect(await climbDescription()).toBe(
      'Swooped is V5 (6c) on Kilter Board Original at 40°, set by BKBChicago. 12 sends, rated 4.2 of 5. Light it on your board with Boardsesh.',
    );
  });

  it('never says "rated 0 of 5" for an unrated climb', async () => {
    const description = await climbDescription({
      angleStats: angleStats({ quality_average: null, rating_count: '0' }),
    });

    expect(description).toBe(
      'Swooped is V5 (6c) on Kilter Board Original at 40°, set by BKBChicago. 12 sends. Light it on your board with Boardsesh.',
    );
    expect(description).not.toContain('rated');
  });

  it('drops the rating when the average is still on the 1-3 scale', async () => {
    const description = await climbDescription({
      angleStats: angleStats({ quality_average: '2.40', quality_normalized: false }),
    });

    expect(description).not.toContain('2.4');
    expect(description).not.toContain('rated');
  });

  it('drops the rating when the angle has no stats row', async () => {
    expect(await climbDescription({ angleStats: undefined })).not.toContain('rated');
  });

  it('never says "0 sends"', async () => {
    const description = await climbDescription({ ascents: 0, angleStats: undefined });

    expect(description).toBe(
      'Swooped is V5 (6c) on Kilter Board Original at 40°, set by BKBChicago. Light it on your board with Boardsesh.',
    );
    expect(description).not.toMatch(/\b0 sends?\b/);
  });

  it('keeps an honest rating on a climb with no sends counted at this angle', async () => {
    expect(await climbDescription({ ascents: null })).toBe(
      'Swooped is V5 (6c) on Kilter Board Original at 40°, set by BKBChicago. Rated 4.2 of 5. Light it on your board with Boardsesh.',
    );
  });

  it('says "1 send", not "1 sends"', async () => {
    expect(await climbDescription({ ascents: 1, angleStats: undefined })).toContain('. 1 send. ');
  });

  it('drops the setter clause instead of crediting "Unknown Setter"', async () => {
    for (const setter of [null, undefined, '', '   ']) {
      const description = await climbDescription({ setter });
      expect(description).toBe(
        'Swooped is V5 (6c) on Kilter Board Original at 40°. 12 sends, rated 4.2 of 5. Light it on your board with Boardsesh.',
      );
      expect(description).not.toContain('Unknown');
    }
  });

  it('formats the counts for the locale', async () => {
    expect(await climbDescription({ ascents: 4171 }, 'de')).toContain('4.171 Begehungen, Bewertung 4,2 von 5.');
  });

  it('calls an angle with no grade "a climb" instead of leaving a gap', async () => {
    expect(await climbDescription({ grade: '', ascents: 0, angleStats: undefined })).toBe(
      'Swooped is a climb on Kilter Board Original at 40°, set by BKBChicago. Light it on your board with Boardsesh.',
    );
    expect(await climbDescription({ grade: ' ', setter: null, ascents: 0, angleStats: undefined })).toBe(
      'Swooped is a climb on Kilter Board Original at 40°. Light it on your board with Boardsesh.',
    );
  });

  it.each(LOCALES)('fills every placeholder and leaves no zero claims in %s', async (locale) => {
    const variants = await Promise.all([
      climbDescription({}, locale),
      climbDescription({ setter: null, ascents: 0, angleStats: undefined }, locale),
      climbDescription({ ascents: 0 }, locale),
      climbDescription({ ascents: 1, angleStats: undefined }, locale),
      climbDescription({ grade: '' }, locale),
      climbDescription({ grade: '', setter: null }, locale),
    ]);

    for (const description of variants) {
      expect(description).not.toContain('{{');
      expect(description).not.toContain('metadata.view');
      expect(description).toContain('Swooped');
      expect(description).toContain('Boardsesh');
      expect(description).not.toMatch(/(^|\D)0(\D|$)/);
    }
  });

  it('runs Chinese sentences together and spaces the rest', () => {
    expect(joinDescriptionSentences(['甲。', null, '乙。'], 'zh-CN')).toBe('甲。乙。');
    expect(joinDescriptionSentences(['One.', null, 'Two.'], 'fr')).toBe('One. Two.');
  });
});

async function setterCopy(
  overrides: Partial<Parameters<typeof buildSetterSearchCopy>[0]> = {},
  locale: CatalogLocale = 'en-US',
) {
  return buildSetterSearchCopy({
    t: await translatorFor(locale, 'profile'),
    locale,
    name: 'BKBChicago',
    climbCount: 41,
    boardTypes: ['kilter'],
    totalAscents: 12345,
    page: 1,
    ...overrides,
  });
}

describe('setter search copy', () => {
  it('names the boards and the climb count in the title, and the sends in the description', async () => {
    expect(await setterCopy()).toEqual({
      title: '41 Kilter climbs set by BKBChicago',
      description:
        'BKBChicago has set 41 climbs on Kilter. 12,345 sends so far. Pick one and light it on your board with Boardsesh.',
    });
  });

  it('lists every board the setter has climbs on, in the order it is given', async () => {
    const { title } = await setterCopy({ boardTypes: ['tension', 'kilter', 'moonboard'] });
    expect(title).toBe('41 Tension, Kilter, and MoonBoard climbs set by BKBChicago');
  });

  it('uses the singular for one climb and one send, with nothing to "pick" from', async () => {
    expect(await setterCopy({ climbCount: 1, totalAscents: 1 })).toEqual({
      title: '1 Kilter climb set by BKBChicago',
      description: 'BKBChicago has set 1 climb on Kilter. 1 send so far. Light it on your board with Boardsesh.',
    });
  });

  it('numbers the later pages, which are indexable too', async () => {
    expect((await setterCopy({ page: 2 })).title).toBe('41 Kilter climbs set by BKBChicago — Page 2');
    expect((await setterCopy({ page: 3, climbCount: null, boardTypes: [] })).title).toBe(
      'Climbs set by BKBChicago — Page 3',
    );
  });

  it.each([
    ['en-US', '3 Kilter and Spraywall climbs set by BKBChicago'],
    ['de', '3 Boulder von BKBChicago auf Kilter und Spraywall'],
    ['zh-CN', 'BKBChicago 在 Kilter和喷点墙 上设置的 3 条线路'],
  ] as const)('names a spray wall the way the %s glossary does', async (locale, title) => {
    expect((await setterCopy({ climbCount: 3, boardTypes: ['kilter', 'spray'] }, locale)).title).toBe(title);
  });

  it('drops the sends sentence when nobody has sent a climb yet', async () => {
    const { description } = await setterCopy({ totalAscents: 0 });
    expect(description).toBe(
      'BKBChicago has set 41 climbs on Kilter. Pick one and light it on your board with Boardsesh.',
    );
  });

  it('falls back to the plain title when the page read failed', async () => {
    expect(await setterCopy({ climbCount: null, boardTypes: [] })).toEqual({
      title: 'Climbs set by BKBChicago',
      description: 'Climbs created by BKBChicago on Boardsesh',
    });
  });

  it.each(LOCALES)('fills every placeholder in %s', async (locale) => {
    const variants = await Promise.all([
      setterCopy({}, locale),
      setterCopy({ climbCount: 1, totalAscents: 1, boardTypes: ['kilter', 'spray'] }, locale),
      setterCopy({ page: 2 }, locale),
    ]);

    for (const { title, description } of variants) {
      for (const text of [title, description]) {
        expect(text).not.toContain('{{');
        expect(text).not.toContain('metadata.setter');
        expect(text).toContain('BKBChicago');
      }
      expect(title).toContain('Kilter');
    }
  });
});
