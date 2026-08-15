import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
const SPANISH_DIR = join(LOCALES_DIR, 'es');

// Spanish has one word for the place the wall lives: `rocódromo`. `gimnasio` is
// the generic fitness gym and read wrong to climbers, so every catalog was swept
// in one pass — this test is what stops the split coming back one string at a
// time. See docs/i18n-spanish-glossary.md.
//
// The regex is deliberately the bare stem `gimnasi`, which also catches
// `gimnasia` (gymnastics). That is safe today: `gimnasia` appears nowhere in the
// catalogs, and Boardsesh has no gymnastics copy to write. If a legitimate
// gymnastics string ever lands, exclude that key path explicitly rather than
// loosening the stem — the whole point is that `gimnasio`/`gimnasios` can never
// slip through.
const BANNED_GYM_TERM = /gimnasi/i;

// `rocódromo` carries an accent in prose. Accented characters do not belong in a
// value someone is meant to type into a URL or an address field, so email, URL
// and slug placeholders use the bare `rocodromo`. Anything else unaccented is a
// missing accent, not an example.
const UNACCENTED_TERM = /rocodromo/i;
const SLUG_EXAMPLE_KEY_PATHS = new Set([
  // "tu-rocodromo" — the URL-slug placeholder on the kiosk setup screen.
  'kiosk.json:manage.slugGuard.placeholder',
]);

// The board is a `plafón`, the gym is a `rocódromo`. A sloppy find/replace in
// either direction eats one of them; pin the board term so we notice.
const BOARD_TERM = 'plafón';
// Floor, not an exact count: 188 Spanish strings say `plafón` today. A bare
// "at least one" assertion would survive a replace that ate 187 of them — which
// is precisely the accident being guarded against — so hold a floor just under
// today's number. Ordinary copy churn stays green; a sweep goes red. Raise this
// if the catalogs grow; never lower it to turn a red test green.
const BOARD_TERM_FLOOR = 180;

// Remove URLs and email addresses from a token so the accent check can look at
// what is left. `rocodromo` is correct inside an address someone types; anywhere
// else it is a dropped accent.
function withoutAddresses(token: string): string {
  return token.replace(/https?:\/\/\S+/gi, ' ').replace(/\S+@\S+/g, ' ');
}

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

function loadSpanishStrings(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const file of readdirSync(SPANISH_DIR).filter((name) => name.endsWith('.json'))) {
    const catalog: unknown = JSON.parse(readFileSync(join(SPANISH_DIR, file), 'utf8'));
    collectStrings(catalog, '', file, entries);
  }
  return entries;
}

const spanishStrings = loadSpanishStrings();

describe('Spanish gym terminology', () => {
  it('loads the Spanish catalogs', () => {
    expect(spanishStrings.length).toBeGreaterThan(0);
  });

  it('never says gimnasio', () => {
    const offenders = spanishStrings
      .filter((entry) => BANNED_GYM_TERM.test(entry.value))
      .map((entry) => `${entry.file}:${entry.keyPath} — ${entry.value}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            `${offenders.length} Spanish string(s) still say "gimnasio". Boardsesh gyms are climbing gyms:`,
            'use "rocódromo" (masculine, plural "rocódromos"). See docs/i18n-spanish-glossary.md.',
            ...offenders.map((offender) => `  - ${offender}`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('only drops the accent in email, URL and slug examples', () => {
    const offenders = spanishStrings
      .filter((entry) => UNACCENTED_TERM.test(entry.value))
      .filter((entry) => !SLUG_EXAMPLE_KEY_PATHS.has(`${entry.file}:${entry.keyPath}`))
      .flatMap((entry) =>
        entry.value
          .split(/\s+/)
          // Exempt only the address itself, not the whole token it sits in:
          // stripping the URL/email first means a genuine missing accent glued to
          // one — "https://x.com/tu-rocodromo,rocodromo" — is still caught.
          .filter((token) => UNACCENTED_TERM.test(withoutAddresses(token)))
          .map((token) => `${entry.file}:${entry.keyPath} — ${token}`),
      );

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            'Unaccented "rocodromo" outside an email, URL or slug example — prose needs the accent:',
            ...offenders.map((offender) => `  - ${offender}`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('still calls the board a plafón', () => {
    const boardTermUses = spanishStrings.filter((entry) => entry.value.includes(BOARD_TERM));
    expect(
      boardTermUses.length,
      `Spanish catalogs say "${BOARD_TERM}" in only ${boardTermUses.length} strings, below the floor of ${BOARD_TERM_FLOOR}. A find/replace on the gym term has probably eaten the board term too.`,
    ).toBeGreaterThanOrEqual(BOARD_TERM_FLOOR);
  });

  it('pins the gym term on the strings that drifted', () => {
    const byPath = new Map(spanishStrings.map((entry) => [`${entry.file}:${entry.keyPath}`, entry.value]));

    expect(byPath.get('boards.json:gymEntity.follow.entityLabel')).toBe('rocódromo');
    expect(byPath.get('kiosk.json:gymPage.claimTitle')).toBe('¿Es tuyo este rocódromo?');
  });
});
