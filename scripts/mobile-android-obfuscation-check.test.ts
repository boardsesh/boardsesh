import { describe, expect, it } from 'vitest';

import { NAME_INVARIANTS, parseMapping, verifyObfuscation } from './mobile-android-obfuscation-check';

const OPTIONS = { minFraction: 0.4, minClasses: 3 };

/** Renders a mapping.txt body: `original -> obfuscated:` plus an indented member. */
function mapping(entries: [original: string, obfuscated: string][]): string {
  return [
    '# compiler: R8',
    '# compiler_version: 8.5.35',
    ...entries.flatMap(([original, obfuscated]) => [
      `${original} -> ${obfuscated}:`,
      '    void onCreate(android.os.Bundle) -> a',
    ]),
    '',
  ].join('\n');
}

/** The three names that must survive, spelled identically on both sides. */
const INVARIANT_ENTRIES = NAME_INVARIANTS.map(({ className }) => [className, className] as [string, string]);

function renamedFiller(count: number, from = 0): [string, string][] {
  return Array.from({ length: count }, (_, index) => [
    `com.facebook.react.Filler${from + index}`,
    `b.a.C${from + index}`,
  ]);
}

describe('parseMapping', () => {
  it('counts renamed and kept classes', () => {
    const stats = parseMapping(
      mapping([
        ['com.example.Kept', 'com.example.Kept'],
        ['com.example.Renamed', 'a.b.c'],
      ]),
    );

    expect(stats.total).toBe(2);
    expect(stats.renamed).toBe(1);
    expect(stats.fraction).toBe(0.5);
  });

  it('ignores comments and indented member lines', () => {
    const stats = parseMapping(['# compiler: R8', '    void member() -> a', '\tint other -> b'].join('\n'));

    expect(stats.total).toBe(0);
  });

  it('handles inner classes and array types in names', () => {
    const stats = parseMapping(
      mapping([
        ['com.example.Outer$Inner', 'a.b$c'],
        ['com.example.Holder[]', 'a.d[]'],
      ]),
    );

    expect(stats.total).toBe(2);
    expect(stats.renamed).toBe(2);
  });

  it('groups kept classes by two-segment package, heaviest first', () => {
    const stats = parseMapping(
      mapping([
        ['com.boardsesh.One', 'com.boardsesh.One'],
        ['com.boardsesh.Two', 'com.boardsesh.Two'],
        ['expo.modules.Three', 'a.b'],
      ]),
    );

    expect(stats.byPackage[0]).toMatchObject({ prefix: 'com.boardsesh', total: 2, renamed: 0 });
  });
});

describe('verifyObfuscation', () => {
  it('passes a healthy mapping', () => {
    const stats = parseMapping(mapping([...INVARIANT_ENTRIES, ...renamedFiller(7)]));
    const verdict = verifyObfuscation(stats, OPTIONS);

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain('name invariants intact');
  });

  // The three failures the guard exists for. Each one is green under a
  // marker-grep of gradle.properties, which is why this reads the artifact.
  it('fails when R8 renamed a name that must survive verbatim', () => {
    const broken = INVARIANT_ENTRIES.map(([className], index) =>
      index === 0 ? ([className, 'a.b.c'] as [string, string]) : ([className, className] as [string, string]),
    );
    const stats = parseMapping(mapping([...broken, ...renamedFiller(7)]));

    const verdict = verifyObfuscation(stats, OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(NAME_INVARIANTS[0]!.className);
    expect(verdict.message).toContain('renamed to a.b.c');
  });

  // mapping.txt lists only classes that survived, so an absent invariant means
  // R8 shrank it away — the same silent catastrophe as a rename.
  it('fails when an invariant class is missing from the mapping entirely', () => {
    const stats = parseMapping(mapping([...INVARIANT_ENTRIES.slice(1), ...renamedFiller(7)]));

    const verdict = verifyObfuscation(stats, OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('absent from the mapping');
  });

  it('fails when a broad keep rule collapses the renamed fraction', () => {
    const kept = Array.from(
      { length: 7 },
      (_, index) => [`com.boardsesh.Kept${index}`, `com.boardsesh.Kept${index}`] as [string, string],
    );
    const stats = parseMapping(mapping([...INVARIANT_ENTRIES, ...kept, ...renamedFiller(2)]));

    const verdict = verifyObfuscation(stats, OPTIONS);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('too broad');
    // Names the culprit rather than just the number.
    expect(verdict.message).toContain('com.boardsesh');
  });

  // A truncated mapping renames 100% of the two classes it lists. Without a floor
  // on size, that is a perfect score proving nothing — the classic vacuous pass.
  it('fails a truncated mapping that would otherwise score 100%', () => {
    const stats = parseMapping(mapping(renamedFiller(2)));

    const verdict = verifyObfuscation(stats, { minFraction: 0.4, minClasses: 2000 });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('truncated');
  });

  it('fails an empty mapping rather than dividing by zero', () => {
    const verdict = verifyObfuscation(parseMapping('# compiler: R8\n'), OPTIONS);

    expect(verdict.ok).toBe(false);
  });
});
