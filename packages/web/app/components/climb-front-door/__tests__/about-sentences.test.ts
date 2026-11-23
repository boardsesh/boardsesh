import 'intl-pluralrules';
import { createInstance } from 'i18next';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import deClimbs from '@boardsesh/i18n/locales/de/climbs.json';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import zhClimbs from '@boardsesh/i18n/locales/zh-CN/climbs.json';
import {
  buildAboutSentences,
  joinAboutSentences,
  type AboutClimbInput,
  type TranslateSentence,
} from '../about-sentences';

// The real catalogs, so these pin the sentences a reader gets, plural forms included.
const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    fallbackLng: 'en-US',
    supportedLngs: ['en-US', 'de', 'zh-CN'],
    ns: ['climbs'],
    defaultNS: 'climbs',
    resources: { 'en-US': { climbs: enClimbs }, de: { climbs: deClimbs }, 'zh-CN': { climbs: zhClimbs } },
    interpolation: { escapeValue: false },
  });
});

function paragraph(input: AboutClimbInput, locale = 'en-US'): string {
  const t: TranslateSentence = (key, values) => i18n.getFixedT(locale, 'climbs')(key, values);
  return joinAboutSentences(buildAboutSentences(input, t, locale), locale);
}

const FULL: AboutClimbInput = {
  climbName: 'it’s a beautiful morning',
  difficulty: '4c/V0',
  boardLabel: 'Kilter Board Original',
  angle: 10,
  setter: 'BKBChicago',
  firstAscentClimber: 'Guill',
  firstAscentAt: '2019-02-14T00:00:00.000Z',
  sendsHere: '4171',
  angleStats: [
    { angle: 0, difficulty: '5a/V1', display_difficulty: 12.4, difficulty_average: 12.4, ascensionist_count: '5' },
    { angle: 10, difficulty: '4c/V0', display_difficulty: 10.6, difficulty_average: 10.6, ascensionist_count: '5' },
    { angle: 30, difficulty: '5c/V2', display_difficulty: 14.1, difficulty_average: 14.1, ascensionist_count: '5' },
  ],
};

describe('buildAboutSentences', () => {
  it('writes every sentence when every fact is there', () => {
    expect(paragraph(FULL)).toBe(
      'it’s a beautiful morning is a V0 (4c) on the Kilter Board Original at 10°, set by BKBChicago. ' +
        'Guill made the first ascent at 10° on Feb 14, 2019. ' +
        'It climbs as V0 (4c) at 10° and V2 (5c) at 30°. ' +
        '4,171 sends logged at this angle.',
    );
  });

  it('drops "set by" when the setter is missing, and the grade when the climb has none', () => {
    expect(paragraph({ ...FULL, setter: '  ' })).toMatch(
      /^it’s a beautiful morning is a V0 \(4c\) on the Kilter Board Original at 10°\. /,
    );
    expect(paragraph({ ...FULL, difficulty: null })).toMatch(
      /^it’s a beautiful morning is a climb on the Kilter Board Original at 10°, set by BKBChicago\. /,
    );
    expect(paragraph({ ...FULL, difficulty: '', setter: null })).toMatch(
      /^it’s a beautiful morning is a climb on the Kilter Board Original at 10°\. /,
    );
  });

  it('drops the first-ascent sentence unless both the climber and a real date are known', () => {
    for (const missing of [
      { firstAscentClimber: null },
      { firstAscentAt: null },
      { firstAscentAt: 'not a date' },
    ] satisfies Partial<AboutClimbInput>[]) {
      expect(paragraph({ ...FULL, ...missing })).not.toContain('first ascent');
    }
  });

  it('never says zero sends', () => {
    for (const sendsHere of [0, '0', null, undefined, 'NaN']) {
      const text = paragraph({ ...FULL, sendsHere });
      expect(text).not.toMatch(/\b0 sends?\b/);
      expect(text).not.toContain('logged at this angle');
    }
    expect(paragraph({ ...FULL, sendsHere: 1 })).toContain('1 send logged at this angle.');
  });

  it('gives a grade range only when the angles differ in grade', () => {
    const oneGrade: AboutClimbInput['angleStats'] = [
      { angle: 0, difficulty: '4c/V0', display_difficulty: 10.2, difficulty_average: 10.2, ascensionist_count: '5' },
      { angle: 10, difficulty: '4c/V0', display_difficulty: 10.6, difficulty_average: 10.6, ascensionist_count: '5' },
    ];
    expect(paragraph({ ...FULL, angleStats: oneGrade })).not.toContain('It climbs as');
    expect(paragraph({ ...FULL, angleStats: [FULL.angleStats[0]] })).not.toContain('It climbs as');
  });

  it('ranks angles by their difficulty number and ignores rows without one', () => {
    const stats: AboutClimbInput['angleStats'] = [
      // A null rank must not read as 0 and win "easiest".
      { angle: 0, difficulty: '7a/V6', display_difficulty: null, difficulty_average: null, ascensionist_count: '5' },
      { angle: 20, difficulty: '6a/V3', display_difficulty: null, difficulty_average: 15.2, ascensionist_count: '5' },
      { angle: 40, difficulty: '6c/V5', display_difficulty: 18.9, difficulty_average: 18.9, ascensionist_count: '5' },
      { angle: 50, difficulty: '', display_difficulty: 22, difficulty_average: 22, ascensionist_count: '5' },
    ];
    expect(paragraph({ ...FULL, angleStats: stats })).toContain('It climbs as V3 (6a) at 20° and V5 (6c) at 40°.');
  });

  it('leaves an angle nobody has sent out of the range', () => {
    const stats: AboutClimbInput['angleStats'] = [
      { angle: 0, difficulty: '6a+/V3', display_difficulty: 16.2, difficulty_average: 16.2, ascensionist_count: '8' },
      {
        angle: 40,
        difficulty: '7a/V8',
        display_difficulty: 25.1,
        difficulty_average: 25.1,
        ascensionist_count: '36615',
      },
      // The setter's guess at an angle with no sends is not how the climb climbs there.
      { angle: 70, difficulty: '7c+/V10', display_difficulty: 28.9, difficulty_average: 28.9, ascensionist_count: '0' },
    ];
    expect(paragraph({ ...FULL, angleStats: stats })).toContain('It climbs as V3 (6a+) at 0° and V8 (7a) at 40°.');
  });

  it('formats numbers and dates in the page locale', () => {
    const german = paragraph(FULL, 'de');
    expect(german).toContain('Die Erstbegehung bei 10° gelang Guill am 14. Feb. 2019.');
    expect(german).toContain('4.171 Begehungen bei diesem Winkel eingetragen.');
    expect(german).toContain('Bei 10° ist er V0 (4c), bei 30° V2 (5c).');
  });

  it('runs Chinese sentences together without spaces', () => {
    const chinese = paragraph(FULL, 'zh-CN');
    expect(chinese).toContain('由 BKBChicago 设定。Guill 于 2019年2月14日 在 10° 首次完攀。');
    expect(chinese).not.toMatch(/。 /);
    expect(chinese.endsWith('此角度已记录 4,171 次完攀。')).toBe(true);
  });
});
