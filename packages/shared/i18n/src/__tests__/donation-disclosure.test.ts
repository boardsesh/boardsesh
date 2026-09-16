import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');

/**
 * The `/support` donations page carries two promises that are legal constraints,
 * not copy taste, and they have to survive a translation pass in every locale:
 *
 *  1. Donations are NOT tax-deductible. Boardsesh is not a registered charity,
 *     so implying a deduction — in any language — is a claim we cannot make.
 *  2. A donation buys nothing. No feature unlocks, no early access, no priority
 *     support, ever.
 *
 * A component test can't enforce either: it renders whatever the catalog says,
 * so resolving the same key it renders would pass against copy that quietly
 * dropped the disclosure. The phrasing is pinned here, per locale, instead.
 */

type Catalog = Record<string, unknown>;

function loadMarketing(locale: string): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'marketing.json'), 'utf8'));
}

function readString(catalog: Catalog, dottedKey: string): string {
  let current: unknown = catalog;
  for (const segment of dottedKey.split('.')) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`missing key ${dottedKey}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'string') {
    throw new Error(`key ${dottedKey} is not a string`);
  }
  return current;
}

/** Each locale's own way of saying "not tax-deductible". */
const NOT_TAX_DEDUCTIBLE: Record<string, RegExp> = {
  'en-US': /not tax-deductible/i,
  es: /no son deducibles de impuestos/i,
  fr: /ne sont pas déductibles/i,
  de: /nicht steuerlich absetzbar/i,
};

/**
 * Perks language, per locale. English terms are listed for every locale on
 * purpose — a half-translated string that leaves "early access" in English is
 * exactly the regression worth catching.
 */
const PERKS_LANGUAGE: Record<string, RegExp> = {
  'en-US': /unlock|early access|priority support|perk|reward|exclusive/i,
  es: /desbloquea|acceso anticipado|soporte prioritario|exclusiv|recompensa|early access|unlock/i,
  fr: /débloque|accès anticipé|support prioritaire|exclusi|récompense|early access|unlock/i,
  de: /schalte.{0,12}frei|freischalt|früher zugang|vorrangig|exklusiv|belohnung|early access|unlock/i,
};

const SUPPORT_COPY_KEYS = [
  'support.hero.title',
  'support.hero.subtitle',
  'support.why.p1',
  'support.why.p2',
  'support.sponsors.body',
  'support.sponsors.cta',
  'support.oneTime.body',
  'support.oneTime.cta',
  'support.honesty.p1',
  'support.honesty.p2',
  'support.thanks.body',
];

describe.each(Object.keys(NOT_TAX_DEDUCTIBLE))('%s donation disclosure', (locale) => {
  const catalog = loadMarketing(locale);

  it('says donations are not tax-deductible', () => {
    expect(readString(catalog, 'support.honesty.p1')).toMatch(NOT_TAX_DEDUCTIBLE[locale]);
  });

  it('promises nothing in return for a donation', () => {
    for (const key of SUPPORT_COPY_KEYS) {
      expect(readString(catalog, key), `${locale}: ${key} must not promise a perk`).not.toMatch(PERKS_LANGUAGE[locale]);
    }
  });

  // `withBrandTitle` in the web app appends " | Boardsesh" unless the title
  // already carries the brand. A title containing "Boardsesh" therefore either
  // doubles the brand or loses the suffix entirely, depending on where it sits.
  it('keeps the brand out of the page title so the suffix can add it', () => {
    expect(readString(catalog, 'metadata.support.title')).not.toMatch(/boardsesh/i);
  });
});
