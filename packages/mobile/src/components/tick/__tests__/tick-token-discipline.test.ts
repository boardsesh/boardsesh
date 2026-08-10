// The guard that stops the hardcoded-colour class from regrowing.
//
// The tick sheets were the worst offenders in the app: a #FFB800 gold star next
// to a #C7C7CC empty one (a light-mode chrome grey, shipped straight into dark
// mode), iosSystemColors.systemGray on the tries stepper, iosSystemColors.white
// on the save CTA. Every one of those is a value that CANNOT respond to the
// colour scheme, and every one survived review because nothing checked.
//
// So this is a source scan, not a render test: it reads the tick family and its
// three consumers and fails on the three shapes that produce a scheme-blind
// colour — importing the static `theme/ios-colors` palette, writing a hex
// literal, or importing `brandColors` / `systemColors` statically instead of
// resolving them through `useTheme()`.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TICK_DIR = fileURLToPath(new URL('..', import.meta.url));
const COMPONENTS_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** The tick family's own modules. `__tests__` is excluded deliberately: a test
 *  may name a colour it asserts on, and it ships nothing to a device. */
function tickFamilyFiles(): string[] {
  return readdirSync(TICK_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => `${TICK_DIR}${entry.name}`);
}

/** The three sheets assembled from the tick family. They are the surfaces the
 *  offending values actually shipped on, so the guard has to reach them too. */
const CONSUMER_FILES = [
  `${COMPONENTS_DIR}play-drawer/QuickTickBar.tsx`,
  `${COMPONENTS_DIR}LogAscentSheet.tsx`,
  `${COMPONENTS_DIR}you/LogbookEditSheet.tsx`,
];

const GUARDED_FILES = [...tickFamilyFiles(), ...CONSUMER_FILES];

function relative(filePath: string): string {
  return filePath.slice(COMPONENTS_DIR.length);
}

function read(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/** `import ... from '<anything>/theme/ios-colors'`. */
const IOS_COLORS_IMPORT = /from\s+['"][^'"]*theme\/ios-colors['"]/;

/** A quoted hex colour — `'#fff'`, `"#FFB800"`, `` `#FFB800FF` ``. Quoted rather
 *  than bare so an issue reference in a comment (`#3922`) is not a finding. */
const HEX_COLOR_LITERAL = /(['"`])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\1/g;

/** A whole `import { ... } from '<anything>/theme/colors'` statement. */
const THEME_COLORS_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]*theme\/colors['"]/g;

/** Palettes that must arrive resolved from the provider, never as a module-scope
 *  constant: both have a light and a dark set, and a static import always picks
 *  the light one. */
const SCHEME_BOUND_PALETTES = ['brandColors', 'brandColorsDark', 'systemColors'];

describe('tick token discipline', () => {
  it('guards the whole tick family and its three consumer sheets', () => {
    expect(GUARDED_FILES.length).toBeGreaterThanOrEqual(12);
    for (const filePath of GUARDED_FILES) {
      expect(() => read(filePath)).not.toThrow();
    }
  });

  it('never imports the static iOS palette', () => {
    const offenders = GUARDED_FILES.filter((filePath) => IOS_COLORS_IMPORT.test(read(filePath))).map(relative);

    expect(offenders).toEqual([]);
  });

  it('never writes a hex colour literal', () => {
    const offenders = GUARDED_FILES.flatMap((filePath) =>
      [...read(filePath).matchAll(HEX_COLOR_LITERAL)].map((match) => `${relative(filePath)}: ${match[0]}`),
    );

    expect(offenders).toEqual([]);
  });

  it('resolves the scheme-bound palettes through useTheme, never a static import', () => {
    const offenders = GUARDED_FILES.flatMap((filePath) =>
      [...read(filePath).matchAll(THEME_COLORS_IMPORT)].flatMap((match) =>
        match[1]
          .split(',')
          .map((binding) =>
            binding
              .trim()
              .split(/\s+as\s+/)[0]
              .trim(),
          )
          .filter((binding) => SCHEME_BOUND_PALETTES.includes(binding))
          .map((binding) => `${relative(filePath)}: ${binding}`),
      ),
    );

    expect(offenders).toEqual([]);
  });
});
