// The live counter under the report note is what holds Send back. It needs a
// singular and a plural form ("1 more characters" read as a typo) and has to
// say it is waiting on Send, in every shipped locale.
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import deClimbs from '@boardsesh/i18n/locales/de/climbs.json';
import enClimbs from '@boardsesh/i18n/locales/en-US/climbs.json';
import esClimbs from '@boardsesh/i18n/locales/es/climbs.json';
import frClimbs from '@boardsesh/i18n/locales/fr/climbs.json';

const KEY = 'mobile.report.reasonRemaining';

const locales = [
  { lng: 'en-US', climbs: enClimbs },
  { lng: 'es', climbs: esClimbs },
  { lng: 'fr', climbs: frClimbs },
  { lng: 'de', climbs: deClimbs },
];

async function translatorFor(lng: string, climbs: object) {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    resources: { [lng]: { climbs } },
    ns: ['climbs'],
    defaultNS: 'climbs',
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance);
}

describe('report reason counter copy', () => {
  it.each(locales)('$lng ships _one and _other keys and no bare base key', ({ climbs }) => {
    const report = (climbs as unknown as { mobile: { report: Record<string, string> } }).mobile.report;
    expect(report.reasonRemaining_one).toBeTruthy();
    expect(report.reasonRemaining_other).toContain('{{count}}');
    expect(report.reasonRemaining).toBeUndefined();
  });

  it.each(locales)('$lng has distinct singular and plural forms', async ({ lng, climbs }) => {
    const t = await translatorFor(lng, climbs);
    const one = t(KEY, { count: 1 });
    const many = t(KEY, { count: 3 });
    expect(one).not.toBe(KEY);
    expect(many).not.toBe(KEY);
    expect(one).not.toBe(many);
    expect(one).toContain('1');
    expect(many).toContain('3');
  });

  it('en-US ties the counter to Send', async () => {
    const t = await translatorFor('en-US', enClimbs);
    expect(t(KEY, { count: 1 })).toBe('Add 1 more character to send');
    expect(t(KEY, { count: 3 })).toBe('Add 3 more characters to send');
  });
});
