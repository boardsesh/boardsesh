// The review bar's string, rendered for real (epic #5346, SW-09).
//
// This exists because of a bug that every type in the codebase was happy with:
// the screen interpolated `{ count }` while all four catalogs write `{{value}}`.
// i18next does not fall back for an unmatched placeholder — it leaves it in the
// string — so what shipped to a climber was the literal text
// "{{value}} holds to check".
//
// A test that only asserted the KEY would have passed. So this one renders the
// real catalog entry through a real i18next instance and looks at the output.

import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import enBoards from '@boardsesh/i18n/locales/en-US/boards.json';
import esBoards from '@boardsesh/i18n/locales/es/boards.json';
import frBoards from '@boardsesh/i18n/locales/fr/boards.json';
import deBoards from '@boardsesh/i18n/locales/de/boards.json';

const CATALOGS = { 'en-US': enBoards, es: esBoards, fr: frBoards, de: deBoards };

function translator(locale: keyof typeof CATALOGS) {
  const instance = createInstance();
  void instance.init({
    lng: locale,
    resources: { [locale]: { boards: CATALOGS[locale] } },
    ns: ['boards'],
    defaultNS: 'boards',
    interpolation: { escapeValue: false },
  });
  return instance;
}

describe('the review bar count', () => {
  it.each(Object.keys(CATALOGS) as (keyof typeof CATALOGS)[])('renders the number in %s', (locale) => {
    const rendered = translator(locale).t('sprayWizard.review.found', { value: 12 });
    expect(rendered).toContain('12');
    // The failure this test is here for: an unmatched placeholder survives into
    // the string a climber reads.
    expect(rendered).not.toContain('{{');
  });

  it('leaves the placeholder in when the wrong name is passed', () => {
    // Pinning the behaviour that makes the bug possible, so the assertion above
    // is known to be load-bearing rather than vacuous.
    const rendered = translator('en-US').t('sprayWizard.review.found', { count: 12 });
    expect(rendered).toContain('{{value}}');
  });
});

describe('the resume prompt', () => {
  it.each(Object.keys(CATALOGS) as (keyof typeof CATALOGS)[])('names the wall in %s', (locale) => {
    const rendered = translator(locale).t('sprayWizard.resume.body', { name: 'Garage wall' });
    expect(rendered).toContain('Garage wall');
    expect(rendered).not.toContain('{{');
  });
});
