import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Live Activity widget is native Swift and localizes through its own
// `Localizable.strings`, not the app's i18next catalogs, so the catalog
// completeness test never sees it. A key missing from one language silently
// renders the English key on that climber's Lock Screen — which is how every
// button but Mirror shipped English-only before #6513.

const WIDGET_TARGET = join(__dirname, '../../../../targets/BoardseshWidgets');
const LANGUAGES = ['en', 'es', 'fr', 'de'] as const;

// Keys the widget's SwiftUI literals resolve through. Interpolated literals
// become format keys: `Text("\(index) of \(total)")` looks up "%lld of %lld".
const REQUIRED_KEYS = [
  'Prev',
  'Next',
  'Previous climb',
  'Next climb',
  'Mirror climb',
  'Unmirror climb',
  'Tap to reconnect',
  'Board disconnected. Tap to reconnect',
  'Wall lit, you are driving',
  'Wall control',
  'Wall held by another climber',
  'On the wall',
  '%@ is on the wall',
  '%lld of %lld',
  'Grade %@',
  'Session ended',
  'Rest timer',
  'Rest',
  'Over your rest',
  'Paused',
  'Every %@',
  "Queue's empty",
  'Since your last climb',
  'Log a climb to start',
];

function parseStrings(language: string): Map<string, string> {
  const text = readFileSync(join(WIDGET_TARGET, `${language}.lproj`, 'Localizable.strings'), 'utf8');
  const entries = new Map<string, string>();
  for (const match of text.matchAll(/^"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)";\s*$/gm)) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

function formatSpecifiers(value: string): string[] {
  return (value.match(/%(?:\d+\$)?(?:lld|@|d)/g) ?? []).map((specifier) => specifier.replace(/\d+\$/, '')).sort();
}

describe('widget Localizable.strings', () => {
  const catalogs = new Map(LANGUAGES.map((language) => [language, parseStrings(language)]));
  const english = catalogs.get('en') ?? new Map<string, string>();

  it('defines every key the widget looks up', () => {
    const missing = REQUIRED_KEYS.filter((key) => !english.has(key));
    expect(missing).toEqual([]);
  });

  it.each(LANGUAGES.filter((language) => language !== 'en'))('%s has exactly the English key set', (language) => {
    const keys = [...(catalogs.get(language)?.keys() ?? [])].sort();
    expect(keys).toEqual([...english.keys()].sort());
  });

  it.each(LANGUAGES)('%s keeps every format specifier of its key', (language) => {
    for (const [key, value] of catalogs.get(language) ?? []) {
      expect({ key, specifiers: formatSpecifiers(value) }).toEqual({ key, specifiers: formatSpecifiers(key) });
    }
  });

  it.each(LANGUAGES)('%s has no empty translations', (language) => {
    const empty = [...(catalogs.get(language) ?? [])].filter(([, value]) => value.trim() === '').map(([key]) => key);
    expect(empty).toEqual([]);
  });
});
