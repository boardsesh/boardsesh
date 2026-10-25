import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type TFunction } from 'i18next';
import sessionEnUs from '@boardsesh/i18n/locales/en-US/session.json';
import sessionEs from '@boardsesh/i18n/locales/es/session.json';
import sessionFr from '@boardsesh/i18n/locales/fr/session.json';
import sessionDe from '@boardsesh/i18n/locales/de/session.json';
import { calendarDaysBetween, formatLastOnWall, resolveLastOnWallLabel } from '../last-on-wall';

// #4979 (docs/current-climb-outside-queue.md, section 6): the four age bands of
// "Last on the wall …", through the real catalogs. Instants are built from LOCAL
// parts, because the bands are the climber's calendar days.
const NOW = new Date(2026, 9, 22, 18, 0).getTime(); // Thursday 22 October 2026, 18:00 local
const SAME_DAY = new Date(2026, 9, 22, 9, 30).getTime();
const YESTERDAY = new Date(2026, 9, 21, 23, 50).getTime();
const TUESDAY = new Date(2026, 9, 20, 12, 0).getTime();
const WEEK_AGO = new Date(2026, 9, 15, 12, 0).getTime();
const LAST_YEAR = new Date(2025, 11, 30, 12, 0).getTime();

const CATALOGS = { 'en-US': sessionEnUs, es: sessionEs, fr: sessionFr, de: sessionDe } as const;
type Locale = keyof typeof CATALOGS;
const translators = {} as Record<Locale, TFunction<'session'>>;

beforeAll(async () => {
  for (const locale of Object.keys(CATALOGS) as Locale[]) {
    const instance = i18next.createInstance();
    await instance.init({
      lng: locale,
      fallbackLng: 'en-US',
      ns: ['session'],
      defaultNS: 'session',
      resources: { [locale]: { session: CATALOGS[locale] } },
      interpolation: { escapeValue: false },
    });
    translators[locale] = instance.getFixedT(locale, 'session') as unknown as TFunction<'session'>;
  }
});

function line(locale: Locale, lastOnWallAt: number): string {
  return formatLastOnWall(lastOnWallAt, NOW, translators[locale], locale);
}

describe('calendarDaysBetween', () => {
  it('counts local calendar days, not 24 h steps', () => {
    expect(calendarDaysBetween(SAME_DAY, NOW)).toBe(0);
    // 18 h 10 min before, but the day before.
    expect(calendarDaysBetween(YESTERDAY, NOW)).toBe(1);
    expect(calendarDaysBetween(TUESDAY, NOW)).toBe(2);
    expect(calendarDaysBetween(WEEK_AGO, NOW)).toBe(7);
  });

  it('reads an instant after now (a server clock running ahead) as the same day', () => {
    expect(calendarDaysBetween(NOW + 60 * 60 * 1000, NOW)).toBe(0);
  });
});

describe('resolveLastOnWallLabel', () => {
  it('picks the band from the calendar-day gap', () => {
    expect(resolveLastOnWallLabel(SAME_DAY, NOW, 'en-US').band).toBe('time');
    expect(resolveLastOnWallLabel(YESTERDAY, NOW, 'en-US').band).toBe('yesterday');
    expect(resolveLastOnWallLabel(TUESDAY, NOW, 'en-US').band).toBe('weekday');
    expect(resolveLastOnWallLabel(new Date(2026, 9, 16, 12, 0).getTime(), NOW, 'en-US').band).toBe('weekday');
    expect(resolveLastOnWallLabel(WEEK_AGO, NOW, 'en-US').band).toBe('date');
  });
});

describe('formatLastOnWall in all four locales', () => {
  it('same calendar day: the time', () => {
    expect(line('en-US', SAME_DAY)).toBe('Last on the wall at 9:30 AM');
    expect(line('es', SAME_DAY)).toBe('En el muro por última vez a las 9:30');
    expect(line('fr', SAME_DAY)).toBe('Au mur pour la dernière fois à 9:30');
    expect(line('de', SAME_DAY)).toBe('Zuletzt um 9:30 am Board beleuchtet');
  });

  it('yesterday', () => {
    expect(line('en-US', YESTERDAY)).toBe('Last on the wall yesterday');
    expect(line('es', YESTERDAY)).toBe('En el muro por última vez ayer');
    expect(line('fr', YESTERDAY)).toBe('Au mur pour la dernière fois hier');
    expect(line('de', YESTERDAY)).toBe('Zuletzt gestern am Board beleuchtet');
  });

  it('2 to 6 days: the weekday, in the case the language writes it', () => {
    expect(line('en-US', TUESDAY)).toBe('Last on the wall Tuesday');
    expect(line('es', TUESDAY)).toBe('En el muro por última vez el martes');
    expect(line('fr', TUESDAY)).toBe('Au mur pour la dernière fois mardi');
    expect(line('de', TUESDAY)).toBe('Zuletzt am Dienstag am Board beleuchtet');
  });

  it('7 days or more: the date, with the year once it is another year', () => {
    expect(line('en-US', WEEK_AGO)).toBe('Last on the wall Oct 15');
    expect(line('es', WEEK_AGO)).toBe('En el muro por última vez el 15 oct');
    expect(line('fr', WEEK_AGO)).toBe('Au mur pour la dernière fois le 15 oct.');
    expect(line('de', WEEK_AGO)).toBe('Zuletzt am 15. Okt. am Board beleuchtet');
    expect(line('en-US', LAST_YEAR)).toBe('Last on the wall Dec 30, 2025');
  });
});
