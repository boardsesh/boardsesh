import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
const LOCALES = ['en-US', 'es', 'fr', 'de'] as const;

/**
 * The supporter tag and the Acknowledgements supporter list (docs/supporters.md)
 * are a thank-you, nothing more:
 *
 *  - The copy promises nothing. A tag that reads like a perk turns a gift into
 *    a purchase, which it is not.
 *  - The Acknowledgements line names no payment processor or store. It ships in
 *    the iOS and Android app in every storefront, including regions where the
 *    app may not point at an outside way to pay.
 *  - Web and mobile show the same word on a profile.
 */

type Catalog = Record<string, unknown>;

function load(locale: string, namespace: string): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${namespace}.json`), 'utf8'));
}

function readString(catalog: Catalog, dottedKey: string): string {
  let current: unknown = catalog;
  for (const segment of dottedKey.split('.')) {
    if (typeof current !== 'object' || current === null) throw new Error(`missing key ${dottedKey}`);
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'string') throw new Error(`key ${dottedKey} is not a string`);
  return current;
}

const PERKS_LANGUAGE =
  /unlock|early access|priority|premium|perk|reward|exclusive|faster|desbloquea|acceso anticipado|prioritari|exclusiv|recompensa|débloque|accès anticipé|récompense|freischalt|früher zugang|vorrangig|exklusiv|belohnung/i;
const PAYMENT_NAMES = /stripe|paypal|github|patreon|apple|google|app store|play store|ko-fi/i;

describe.each(LOCALES)('supporter copy (%s)', (locale) => {
  const webTag = readString(load(locale, 'profile'), 'page.supporterTag');
  const mobileTag = readString(load(locale, 'you'), 'mobile.social.supporterTag');
  const listBody = readString(load(locale, 'common'), 'mobile.acknowledgements.supportersBody');

  it('shows the same tag on web and mobile profiles', () => {
    expect(webTag.trim()).not.toBe('');
    expect(mobileTag).toBe(webTag);
  });

  it('promises nothing in the tag or the supporter list line', () => {
    expect(webTag).not.toMatch(PERKS_LANGUAGE);
    expect(listBody).not.toMatch(PERKS_LANGUAGE);
  });

  it('names no payment processor or store in the supporter list line', () => {
    expect(listBody).not.toMatch(PAYMENT_NAMES);
  });
});
