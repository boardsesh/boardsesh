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

function loadCatalog(locale: string, namespace: string): Catalog {
  return JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${namespace}.json`), 'utf8'));
}

function loadMarketing(locale: string): Catalog {
  return loadCatalog(locale, 'marketing');
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

/** Each locale's "amounts are never shown" on the public-credit switch. */
const AMOUNTS_NEVER_SHOWN: Record<string, RegExp> = {
  'en-US': /amounts are never shown/i,
  es: /nunca mostramos importes/i,
  fr: /montants ne sont jamais affichés/i,
  de: /beträge zeigen wir nie/i,
};

/** Cardinals that would turn the rails heading into a promise, per locale. */
const RAIL_COUNT_WORDS: Record<string, RegExp> = {
  'en-US': /\b(one|two|1|2)\b/i,
  es: /\b(dos|2)\b|\buna? forma\b/i,
  fr: /\b(deux|2)\b|\bune fa\u00e7on\b/i,
  de: /\b(zwei|2)\b|\bein Weg\b/i,
};

const SUPPORT_COPY_KEYS = [
  'support.hero.title',
  'support.hero.subtitle',
  'support.promise',
  'support.why.p1',
  'support.why.p2',
  'support.rails.title',
  'support.sponsors.body',
  'support.sponsors.cta',
  'support.oneTime.body',
  'support.oneTime.cta',
  // The monthly-first layout, shown once SUPPORT_MONTHLY_LINKS_* is set.
  'support.hero.ctaMonthly',
  'support.promiseMonthly',
  'support.why.p1Monthly',
  'support.why.p2Monthly',
  'support.chooser.perMonth',
  'support.chooser.monthly',
  'support.chooser.once',
  'support.chooser.monthlyBody',
  'support.chooser.publicName',
  'support.chooser.manage',
  'support.thanksState.title',
  'support.thanksState.body',
  // "Other ways to help" is the non-monetary column. It is the copy most likely
  // to drift into promising something back, so every string on it is listed.
  'support.otherWays.title',
  'support.otherWays.body',
  'support.otherWays.bug.title',
  'support.otherWays.bug.body',
  'support.otherWays.bug.cta',
  'support.otherWays.translate.title',
  'support.otherWays.translate.body',
  'support.otherWays.translate.cta',
  'support.otherWays.patch.title',
  'support.otherWays.patch.body',
  'support.otherWays.patch.cta',
  'support.otherWays.discord.title',
  'support.otherWays.discord.body',
  'support.otherWays.discord.cta',
  'support.honesty.p1',
  'support.honesty.p2',
  'support.honesty.p1Monthly',
  'support.honesty.p2Monthly',
  'support.thanks.body',
  // The homepage support block carries the same ask above the footer, so it
  // carries the same constraint. Its "not got money spare?" column reuses the
  // `support.otherWays.*` titles above rather than duplicating them.
  'home.support.eyebrow',
  'home.support.title',
  'home.support.p1',
  'home.support.p2',
  'home.support.chipIn',
  'home.support.source',
  'home.support.otherWays',
  // The monthly banner on the homepage.
  'home.supportBanner.text',
  'home.supportBanner.cta',
  // The /about supporter list.
  'about.supporters.title',
  'about.supporters.body',
  'about.supporters.accountsTitle',
  'about.supporters.cta',
];

/**
 * Every string under `prefix`, as `[dottedKey, copy]` pairs, so a key added
 * later is checked without anyone remembering to list it.
 */
function collectStrings(catalog: Catalog, prefix: string): Array<[string, string]> {
  const collected: Array<[string, string]> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') {
      collected.push([path, node]);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [segment, child] of Object.entries(node)) walk(child, `${path}.${segment}`);
  };
  let root: unknown = catalog;
  for (const segment of prefix.split('.')) {
    root = typeof root === 'object' && root !== null ? (root as Record<string, unknown>)[segment] : undefined;
  }
  walk(root, prefix);
  return collected;
}

/**
 * The supporter panel (`settings` namespace `supporter.*`): the `/support`
 * thank-you card and `/settings`. It names the Supporter tag, so it is the
 * copy most likely to drift into selling it. Every string under it is checked.
 */
const SUPPORTER_PANEL_PREFIX = 'supporter';

/** Words a thank-you tag must never sit beside, in any locale (the tag is a label, not a tier). */
const TAG_PERKS_LANGUAGE = /priority|premium|faster|prioritari|premium|plus rapide|schneller|más rápido/i;

describe.each(Object.keys(NOT_TAX_DEDUCTIBLE))('%s donation disclosure', (locale) => {
  const catalog = loadMarketing(locale);

  // Both layouts' small print: the fallback page and the monthly-first one.
  it.each(['support.honesty.p1', 'support.honesty.p1Monthly'])('says donations are not tax-deductible (%s)', (key) => {
    expect(readString(catalog, key)).toMatch(NOT_TAX_DEDUCTIBLE[locale]);
  });

  // A monthly button's label is the env's amount only ("A$5"); this template
  // adds the cadence in the visitor's language. Losing the placeholder would
  // drop the amount from every button.
  it('wraps the monthly amount in a per-month template', () => {
    const template = readString(catalog, 'support.chooser.perMonth');
    expect(template).toContain('{{amount}}');
    expect(template.replace('{{amount}}', '').trim().length).toBeGreaterThan(0);
  });

  it('promises nothing in return for a donation', () => {
    for (const key of SUPPORT_COPY_KEYS) {
      expect(readString(catalog, key), `${locale}: ${key} must not promise a perk`).not.toMatch(PERKS_LANGUAGE[locale]);
    }
  });

  it('keeps the supporter panel a thank-you, not a perk', () => {
    const panelStrings = collectStrings(loadCatalog(locale, 'settings'), SUPPORTER_PANEL_PREFIX);
    expect(panelStrings.length).toBeGreaterThan(20);
    for (const [key, copy] of panelStrings) {
      expect(copy, `${locale}: ${key} must not promise a perk`).not.toMatch(PERKS_LANGUAGE[locale]);
      expect(copy, `${locale}: ${key} must not promise a perk`).not.toMatch(TAG_PERKS_LANGUAGE);
    }
  });

  // Public credit is opt-in. The switch's hint must say amounts never show, so
  // nobody turns it on expecting a number beside their name.
  it('says amounts are never shown beside public credit', () => {
    const hint = readString(loadCatalog(locale, 'settings'), 'supporter.visibility.hint');
    expect(hint).toMatch(AMOUNTS_NEVER_SHOWN[locale]);
  });

  // `withBrandTitle` in the web app appends " | Boardsesh" unless the title
  // already carries the brand. A title containing "Boardsesh" therefore either
  // doubles the brand or loses the suffix entirely, depending on where it sits.
  // The Stripe rail renders only when STRIPE_DONATE_URL is set, which it is not
  // in production today. A heading that counts the rails is therefore wrong
  // half the time, in whichever direction — so it must not count them at all.
  // Cardinals only: the indefinite articles (un/una/une/eine) are ordinary
  // words here, and Spanish "echar una mano" is an idiom, not a count.
  it('does not count the donation rails in their heading', () => {
    expect(readString(catalog, 'support.rails.title')).not.toMatch(RAIL_COUNT_WORDS[locale]);
  });

  it('keeps the brand out of the page title so the suffix can add it', () => {
    expect(readString(catalog, 'metadata.support.title')).not.toMatch(/boardsesh/i);
  });
});
