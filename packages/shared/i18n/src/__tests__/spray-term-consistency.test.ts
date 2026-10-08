import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');

// A spray wall has one name per language, and every back-reference to it uses
// the same word (#5960):
//   es  Spraywall         (el Spraywall, los Spraywalls; untranslated, masculine)
//   fr  spray wall        (le spray wall, les spray walls)
//   de  Spraywall         (die Spraywall, die Spraywalls)
// Before this test the catalogs mixed five to six names per language (muro de
// spray, plafones spray, mur de pan, Spraywand, "Spray Walls" ...). See the
// "Spray wall" section of docs/i18n-{spanish,french,german}-glossary.md.
//
// Two kinds of check:
//   1. GLOBAL: the retired full names are banned in every string. They only ever
//      meant a spray wall.
//   2. SCOPED: the bare words (muro, mur, Wand, Board) are legitimate elsewhere
//      (a German gym has a Wand), so they are banned only in spray-wall strings.
//      A string is a spray-wall string when its key path or its value says
//      "spray", or its key is listed in EXTRA_SPRAY_KEYS below.

type CatalogEntry = { file: string; keyPath: string; value: string };

function collectStrings(node: unknown, prefix: string, file: string, into: CatalogEntry[]): void {
  if (typeof node === 'string') {
    into.push({ file, keyPath: prefix, value: node });
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node)) {
    collectStrings(child, prefix ? `${prefix}.${key}` : key, file, into);
  }
}

function loadStrings(locale: string): CatalogEntry[] {
  const directory = join(LOCALES_DIR, locale);
  const entries: CatalogEntry[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    const catalog: unknown = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    collectStrings(catalog, '', file, entries);
  }
  return entries;
}

// Spray-wall strings whose key and value never say "spray".
const EXTRA_SPRAY_KEYS = new Set([
  'boards.json:mobile.manage.deleteWallMessage',
  'climbs.json:createClimbForm.cannotOpen.wallArchived',
  // Shown only on a spray wall with no climbs; the copy never says "spray".
  'climbs.json:mobile.emptyState.unsetWall.title',
  'climbs.json:mobile.emptyState.unsetWall.subtitle',
]);

// "Not a climbing wall": the report reason for a photo that is no wall at all.
// It is the gym-wall sense, not the spray wall.
const NOT_A_WALL_KEY = 'boards.json:sprayModeration.reasons.notAWall';

function isSprayString(entry: CatalogEntry): boolean {
  return (
    /spray/i.test(entry.keyPath) || /spray/i.test(entry.value) || EXTRA_SPRAY_KEYS.has(`${entry.file}:${entry.keyPath}`)
  );
}

// Store listing folders per locale. `keywords.txt` is skipped on purpose: it
// keeps "pan" and "Spraywand" so searches still find the app.
const METADATA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'fastlane',
  'metadata',
);
const STORE_FOLDERS: Record<'es' | 'fr' | 'de', string[]> = {
  es: ['es-ES', 'es-MX', 'android/es-ES'],
  fr: ['fr-FR', 'android/fr-FR'],
  de: ['de-DE', 'android/de-DE'],
};

function loadStoreTexts(locale: 'es' | 'fr' | 'de'): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const folder of STORE_FOLDERS[locale]) {
    const directories = [join(METADATA_DIR, folder), join(METADATA_DIR, folder, 'changelogs')];
    for (const directory of directories.filter((candidate) => existsSync(candidate))) {
      for (const file of readdirSync(directory, { withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.txt') || file.name === 'keywords.txt') continue;
        const value = readFileSync(join(directory, file.name), 'utf8');
        entries.push({ file: `fastlane/metadata/${folder}`, keyPath: file.name, value });
      }
    }
  }
  return entries;
}

type TermRule = {
  locale: 'es' | 'fr' | 'de';
  // What the term is, for the failure message.
  term: string;
  glossary: string;
  // Retired full names. Banned in every string.
  bannedEverywhere: RegExp;
  // Bare back-references. Banned in spray-wall strings only.
  bannedInSprayStrings: RegExp;
  // `file:keyPath` entries that are about boards in general, not one spray wall.
  scopedAllowlist: ReadonlySet<string>;
  // The right term must still be there, so a sweep that eats it goes red.
  requiredTerm: RegExp;
  requiredTermFloor: number;
};

const RULES: TermRule[] = [
  {
    locale: 'es',
    term: '"Spraywall" / "Spraywalls", untranslated and masculine (el Spraywall)',
    glossary: 'docs/i18n-spanish-glossary.md',
    bannedEverywhere: /\bmuros?\s+(?:de\s+)?spray\b|\bplaf(?:ones|ón)\s+(?:de\s+)?(?:presas|spray)\b/i,
    // Plafón is the Kilter/Tension/MoonBoard board; the spray wall is never one.
    bannedInSprayStrings: /\bmuros?\b|\bplaf(?:ones|ón)/i,
    scopedAllowlist: new Set([
      NOT_A_WALL_KEY,
      // "Añádelo a tus plafones": the climber's boards in general, spray walls among them.
      'boards.json:sprayWizard.publish.title',
      // "Encuentra un rocódromo con plafones": gyms with any board.
      'climbs.json:spray.gymsLink',
    ]),
    requiredTerm: /Spraywalls?/,
    requiredTermFloor: 99,
  },
  {
    locale: 'fr',
    term: '"spray wall" / "spray walls"',
    glossary: 'docs/i18n-french-glossary.md',
    bannedEverywhere: /\bmurs?\s+(?:de\s+)?(?:spray|pan)\b/i,
    // `spray` must always be followed by `wall`, and the wall is never a "mur".
    bannedInSprayStrings: /\bmurs?\b|\bspray\b(?!\s+walls?\b)/i,
    scopedAllowlist: new Set([NOT_A_WALL_KEY]),
    requiredTerm: /spray walls?/i,
    requiredTermFloor: 100,
  },
  {
    locale: 'de',
    term: '"Spraywall" / "Spraywalls", one word, feminine',
    glossary: 'docs/i18n-german-glossary.md',
    bannedEverywhere: /Spraywand|Spraywände|Spraywänden|Spray\s+Walls?\b/i,
    // `Board` is the device in German, never the spray wall. Compounds such as
    // Kletterwand, Wandfoto and Garagenwand are caught by the `wand` stem.
    bannedInSprayStrings: /\bWand\b|\bWände\b|\bWänden\b|\w+wand\b|\bWand\w+|\bBoards?\b/,
    scopedAllowlist: new Set([
      NOT_A_WALL_KEY,
      // "Ab zu deinen Boards": the list of the climber's boards, spray walls among them.
      'boards.json:sprayWizard.publish.title',
      // "Finde eine Halle mit Boards": gyms with any board, not one spray wall.
      'climbs.json:spray.gymsLink',
    ]),
    requiredTerm: /Spraywalls?/,
    requiredTermFloor: 97,
  },
];

describe.each(RULES)('$locale spray wall terminology', (rule) => {
  const strings = loadStrings(rule.locale);
  const sprayStrings = strings.filter(isSprayString);

  it('finds the spray-wall strings', () => {
    // Floor at about 80% of today's 398. Not exact: the epic keeps adding spray copy. A scope regex that
    // quietly matched nothing would make every check below pass for free.
    expect(sprayStrings.length).toBeGreaterThanOrEqual(318);
  });

  it('never uses a retired full name for the spray wall', () => {
    const offenders = strings
      .filter((entry) => rule.bannedEverywhere.test(entry.value))
      .map((entry) => `${entry.file}:${entry.keyPath} — ${entry.value}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            `${offenders.length} ${rule.locale} string(s) use a retired name for the spray wall.`,
            `The one term is ${rule.term}. See ${rule.glossary}.`,
            ...offenders.map((offender) => `  - ${offender}`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('never uses a retired full name in the store listing text', () => {
    const storeTexts = loadStoreTexts(rule.locale);
    expect(storeTexts.length).toBeGreaterThan(0);
    const offenders = storeTexts.flatMap((entry) =>
      entry.value
        .split('\n')
        .filter((line) => rule.bannedEverywhere.test(line))
        .map((line) => `${entry.file}/${entry.keyPath} — ${line}`),
    );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            `${offenders.length} ${rule.locale} store listing line(s) use a retired name for the spray wall.`,
            `The one term is ${rule.term}. keywords.txt is exempt. See ${rule.glossary}.`,
            ...offenders.map((offender) => `  - ${offender}`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('never falls back to the bare word for the wall in a spray-wall string', () => {
    const offenders = sprayStrings
      .filter((entry) => !rule.scopedAllowlist.has(`${entry.file}:${entry.keyPath}`))
      .filter((entry) => rule.bannedInSprayStrings.test(entry.value))
      .map((entry) => `${entry.file}:${entry.keyPath} — ${entry.value}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            `${offenders.length} ${rule.locale} spray-wall string(s) name the wall with the wrong word.`,
            `Use ${rule.term}. See ${rule.glossary}.`,
            ...offenders.map((offender) => `  - ${offender}`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('still uses the spray wall term', () => {
    const uses = strings.filter((entry) => rule.requiredTerm.test(entry.value));
    expect(
      uses.length,
      `${rule.locale} catalogs use the spray wall term in only ${uses.length} strings, below the floor of ${rule.requiredTermFloor}. A find/replace has probably eaten it.`,
    ).toBeGreaterThanOrEqual(rule.requiredTermFloor);
  });
});

describe('spray wall term pins', () => {
  it('pins the term on the strings that drifted most', () => {
    const lookup = (locale: string) =>
      new Map(loadStrings(locale).map((entry) => [`${entry.file}:${entry.keyPath}`, entry.value]));

    expect(lookup('es').get('boards.json:mobile.boardDetail.spray.kind')).toBe('Spraywall');
    expect(lookup('fr').get('boards.json:mobile.boardDetail.spray.kind')).toBe('Spray wall');
    expect(lookup('de').get('boards.json:mobile.boardDetail.spray.kind')).toBe('Spraywall');
  });
});
