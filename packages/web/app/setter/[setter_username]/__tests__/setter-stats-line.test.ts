import { describe, expect, it } from 'vite-plus/test';
import { createInstance, type TFunction } from 'i18next';
import enProfile from '@boardsesh/i18n/locales/en-US/profile.json';
import esProfile from '@boardsesh/i18n/locales/es/profile.json';
import frProfile from '@boardsesh/i18n/locales/fr/profile.json';
import deProfile from '@boardsesh/i18n/locales/de/profile.json';
import itProfile from '@boardsesh/i18n/locales/it/profile.json';
import zhProfile from '@boardsesh/i18n/locales/zh-CN/profile.json';
import { buildSetterStatsLine } from '../setter-stats-line';

const CATALOGS = {
  'en-US': enProfile,
  es: esProfile,
  fr: frProfile,
  de: deProfile,
  it: itProfile,
  'zh-CN': zhProfile,
} as const;

type CatalogLocale = keyof typeof CATALOGS;
const LOCALES = Object.keys(CATALOGS) as CatalogLocale[];

/** A real i18next `t` over the shipped catalogs, so the assertions read the line a visitor gets. */
async function translatorFor(locale: CatalogLocale): Promise<TFunction> {
  const instance = createInstance();
  await instance.init({
    lng: locale,
    fallbackLng: 'en-US',
    ns: ['profile'],
    defaultNS: 'profile',
    resources: { [locale]: { profile: CATALOGS[locale] }, 'en-US': { profile: CATALOGS['en-US'] } },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance.t;
}

async function lineFor(
  locale: CatalogLocale,
  climbCount: number,
  boardTypes: readonly string[],
  totalAscents: number,
): Promise<string> {
  return buildSetterStatsLine({ t: await translatorFor(locale), locale, climbCount, boardTypes, totalAscents });
}

describe('buildSetterStatsLine', () => {
  it('names the climbs, the boards and the sends', async () => {
    expect(await lineFor('en-US', 41, ['kilter', 'tension'], 9860)).toBe(
      '41 climbs on Kilter and Tension, sent 9,860 times',
    );
  });

  it('leaves the sends out for a setter nobody has sent yet, instead of "sent 0 times"', async () => {
    expect(await lineFor('en-US', 41, ['kilter'], 0)).toBe('41 climbs on Kilter');
  });

  it('pluralises each half on its own count', async () => {
    expect(await lineFor('en-US', 1, ['kilter'], 1)).toBe('1 climb on Kilter, sent once');
    expect(await lineFor('en-US', 1, ['kilter'], 2)).toBe('1 climb on Kilter, sent 2 times');
    expect(await lineFor('en-US', 2, ['kilter'], 1)).toBe('2 climbs on Kilter, sent once');
  });

  it('names one board alone and three as a list, with their brand spelling', async () => {
    expect(await lineFor('en-US', 3, ['moonboard'], 0)).toBe('3 climbs on MoonBoard');
    expect(await lineFor('en-US', 3, ['kilter', 'moonboard', 'tension'], 0)).toBe(
      '3 climbs on Kilter, MoonBoard, and Tension',
    );
  });

  it('names a spray wall with the glossary word the search title uses, not as a brand', async () => {
    expect(await lineFor('en-US', 3, ['kilter', 'spray'], 0)).toBe('3 climbs on Kilter and Spraywall');
    expect(await lineFor('zh-CN', 3, ['spray'], 0)).toBe('喷点墙 上的 3 条线路');
  });

  it('formats both numbers for the locale', async () => {
    expect(await lineFor('de', 1234, ['kilter'], 98765)).toBe('1.234 Boulder auf Kilter, 98.765 Begehungen');
    expect(await lineFor('fr', 41, ['kilter', 'tension'], 9860)).toBe('41 blocs sur Kilter et Tension, 9 860 croix');
  });

  it('follows the send words the glossaries fix', async () => {
    expect(await lineFor('es', 41, ['kilter'], 2)).toBe('41 bloques en Kilter, con 2 encadenes');
    expect(await lineFor('it', 41, ['kilter'], 2)).toBe('41 blocchi su Kilter, 2 ripetizioni');
    expect(await lineFor('zh-CN', 41, ['kilter'], 2)).toBe('Kilter 上的 41 条线路，已完攀 2 次');
  });

  it.each(LOCALES)('fills every placeholder in %s, with and without sends', async (locale) => {
    for (const sends of [0, 1, 7, 9860]) {
      for (const climbs of [1, 41]) {
        const line = await lineFor(locale, climbs, ['kilter', 'tension'], sends);
        expect(line).not.toMatch(/\{\{|\}\}|setter\.stats/);
        expect(line).toContain('Kilter');
        expect(line).toContain('Tension');
      }
    }
  });
});
