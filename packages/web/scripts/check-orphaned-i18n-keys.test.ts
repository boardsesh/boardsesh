import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeFile,
  appRoot,
  computeForeignMobileNamespaces,
  computeMissingKeys,
  computeOrphans,
  discoverFiles,
  formatReport,
  isExcluded,
  mobileAppRoot,
  mobileSrcRoot,
  scriptsRoot,
} from './check-orphaned-i18n-keys';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const fakePath = '/tmp/fake-component.tsx';
const fakeTsPath = '/tmp/fake-helper.ts';

function analyze(source: string, path: string = fakePath) {
  return analyzeFile(path, source);
}

const mobilePath = '/repo/packages/mobile/src/components/Fake.tsx';
const webPath = '/repo/packages/web/app/components/Fake.tsx';

function toCatalogMap(catalog: Record<string, string[]>) {
  const catalogMap = new Map<string, Set<string>>();
  for (const [namespace, keys] of Object.entries(catalog)) {
    catalogMap.set(namespace, new Set(keys));
  }
  return catalogMap;
}

function missingKeys(catalog: Record<string, string[]>, analyses: ReturnType<typeof analyzeFile>[]) {
  return computeMissingKeys(
    toCatalogMap(catalog),
    analyses.flatMap((analysis) => analysis.references),
  );
}

function foreignMobileNamespaces(analysesByFile: Record<string, ReturnType<typeof analyzeFile>>) {
  const namespacesByFile = new Map<string, ReadonlySet<string>>();
  for (const [file, analysis] of Object.entries(analysesByFile)) {
    namespacesByFile.set(file, analysis.referencedNamespaces);
  }
  return computeForeignMobileNamespaces(namespacesByFile);
}

function namespaceOrphans(
  catalog: Record<string, string[]>,
  analyses: ReturnType<typeof analyzeFile>[],
  keepHints: Set<string> = new Set(),
) {
  const catalogMap = new Map<string, Set<string>>();
  for (const [namespace, keys] of Object.entries(catalog)) {
    catalogMap.set(namespace, new Set(keys));
  }
  const usedKeys = new Map<string, Set<string>>();
  const globs = new Map<string, Parameters<typeof computeOrphans>[2] extends Map<string, infer V> ? V : never>();
  for (const analysis of analyses) {
    for (const [namespace, keys] of analysis.usedKeys) {
      let target = usedKeys.get(namespace);
      if (!target) {
        target = new Set();
        usedKeys.set(namespace, target);
      }
      for (const key of keys) target.add(key);
    }
    for (const [namespace, patterns] of analysis.globs) {
      const target = globs.get(namespace) ?? [];
      target.push(...patterns);
      globs.set(namespace, target);
    }
    for (const hint of analysis.keepHints) keepHints.add(hint);
  }
  return computeOrphans(catalogMap, usedKeys, globs, keepHints);
}

describe('static t() calls', () => {
  it('records the key against the namespace from useTranslation', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('marketing');
        return <span>{t('home.hero.title')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('marketing')?.has('home.hero.title')).toBe(true);
    expect(analysis.unanalyzable).toHaveLength(0);
  });

  it('defaults to the common namespace when useTranslation has no argument', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation();
        return <span>{t('greeting')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('common')?.has('greeting')).toBe(true);
  });

  it('honours an explicit ns:key prefix and ignores the binding namespace', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('common');
        return <span>{t('marketing:home.hero.title')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('marketing')?.has('home.hero.title')).toBe(true);
    expect(analysis.usedKeys.get('common')?.has('marketing:home.hero.title')).toBeFalsy();
  });

  it('records the key in every bound namespace when useTranslation gets an array', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation(['climbs', 'session']);
        return <span>{t('shared.label')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('climbs')?.has('shared.label')).toBe(true);
    expect(analysis.usedKeys.get('session')?.has('shared.label')).toBe(true);
  });

  it('resolves t bindings from getServerTranslation', () => {
    const analysis = analyze(`
      import { getServerTranslation } from '@/app/lib/i18n/server';
      export default async function Page() {
        const { t } = await getServerTranslation('marketing');
        return <h1>{t('about.headerTitle')}</h1>;
      }
    `);
    expect(analysis.usedKeys.get('marketing')?.has('about.headerTitle')).toBe(true);
  });
});

describe('template literal globs', () => {
  it('emits a wildcard glob for `prefix.${expr}.suffix` and matches catalog keys', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ kind }: { kind: string }) {
        const { t } = useTranslation('admin');
        return <span>{t(\`settings.rows.\${kind}.label\`)}</span>;
      }
    `);
    const orphans = namespaceOrphans(
      {
        admin: ['settings.rows.foo.label', 'settings.rows.bar.label', 'settings.unrelated'],
      },
      [analysis],
    );
    expect(orphans.map((orphan) => orphan.key)).toEqual(['settings.unrelated']);
  });

  it('handles a dynamic segment at the trailing position', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ code }: { code: string }) {
        const { t } = useTranslation('auth');
        return <span>{t(\`error.messages.\${code}\`)}</span>;
      }
    `);
    const orphans = namespaceOrphans(
      { auth: ['error.messages.AccessDenied', 'error.messages.Verification', 'login.title'] },
      [analysis],
    );
    expect(orphans.map((orphan) => orphan.key)).toEqual(['login.title']);
  });

  it('treats `ns:${expr}.suffix` template namespaces as glob over that namespace only', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ slot }: { slot: string }) {
        const { t } = useTranslation('common');
        return <span>{t(\`marketing:\${slot}.title\`)}</span>;
      }
    `);
    const orphans = namespaceOrphans(
      {
        marketing: ['hero.title', 'about.title'],
        common: ['hero.title'],
      },
      [analysis],
    );
    // The marketing keys match the glob; the common one is unaffected.
    expect(orphans.map((orphan) => `${orphan.namespace}:${orphan.key}`)).toEqual(['common:hero.title']);
  });
});

describe('Trans component', () => {
  it('records i18nKey from <Trans> using the surrounding useTranslation namespace', () => {
    const analysis = analyze(`
      import { useTranslation, Trans } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('settings');
        return <Trans i18nKey="account.delete.body" t={t} components={{ strong: <strong /> }} />;
      }
    `);
    expect(analysis.usedKeys.get('settings')?.has('account.delete.body')).toBe(true);
  });
});

describe('TFunction parameter bindings', () => {
  it("uses the namespace from `TFunction<'auth'>` annotations", () => {
    const analysis = analyze(
      `
      import type { TFunction } from 'i18next';
      export function getAuthErrorMessage(code: string, t: TFunction<'auth'>) {
        return t('error.messages.default');
      }
    `,
      fakeTsPath,
    );
    expect(analysis.usedKeys.get('auth')?.has('error.messages.default')).toBe(true);
  });

  it('falls back to "any namespace" for bare `TFunction`, suppressing orphan reports across all namespaces', () => {
    const analysis = analyze(
      `
      import type { TFunction } from 'i18next';
      export function format(t: TFunction) {
        return t('shared.label');
      }
    `,
      fakeTsPath,
    );
    const orphans = namespaceOrphans(
      {
        common: ['shared.label', 'unused'],
        feed: ['shared.label'],
      },
      [analysis],
    );
    expect(orphans.map((orphan) => `${orphan.namespace}:${orphan.key}`)).toEqual(['common:unused']);
  });

  it("handles a tuple namespace annotation `TFunction<['climbs', 'session']>`", () => {
    const analysis = analyze(
      `
      import type { TFunction } from 'i18next';
      export function format(t: TFunction<['climbs', 'session']>) {
        return t('shared.label');
      }
    `,
      fakeTsPath,
    );
    expect(analysis.usedKeys.get('climbs')?.has('shared.label')).toBe(true);
    expect(analysis.usedKeys.get('session')?.has('shared.label')).toBe(true);
  });
});

describe('plural variants', () => {
  it('treats `_one`/`_other`/`_few` keys as referenced when the base key is referenced', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('admin');
        return <span>{t('settings.snackbar.saved', { count: 1 })}</span>;
      }
    `);
    const orphans = namespaceOrphans(
      {
        admin: [
          'settings.snackbar.saved',
          'settings.snackbar.saved_one',
          'settings.snackbar.saved_other',
          'settings.snackbar.saved_few',
        ],
      },
      [analysis],
    );
    expect(orphans).toEqual([]);
  });

  it('still flags an unused base whose plural variants are also unreferenced', () => {
    const orphans = namespaceOrphans({ admin: ['unused.thing_one', 'unused.thing_other'] }, [
      analyze(`export const noop = 1;`, fakeTsPath),
    ]);
    expect(orphans.map((orphan) => orphan.key).sort()).toEqual(['unused.thing_one', 'unused.thing_other']);
  });
});

describe('// i18n-keep markers', () => {
  it('exempts a key listed in a keep marker', () => {
    const analysis = analyze(
      `
      // i18n-keep common.headerCopy.legacyTitle
      export const noop = 1;
    `,
      fakeTsPath,
    );
    const orphans = namespaceOrphans({ common: ['headerCopy.legacyTitle', 'unused'] }, [analysis]);
    expect(orphans.map((orphan) => orphan.key)).toEqual(['unused']);
  });

  it('accepts the colon form `// i18n-keep ns:key.path`', () => {
    const analysis = analyze(
      `
      // i18n-keep common:headerCopy.legacyTitle
      export const noop = 1;
    `,
      fakeTsPath,
    );
    const orphans = namespaceOrphans({ common: ['headerCopy.legacyTitle'] }, [analysis]);
    expect(orphans).toEqual([]);
  });
});

describe('unanalyzable t() arguments', () => {
  it('records a hard-fail site for `t(variable)`', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ key }: { key: string }) {
        const { t } = useTranslation('common');
        return <span>{t(key)}</span>;
      }
    `);
    expect(analysis.unanalyzable).toHaveLength(1);
    expect(analysis.unanalyzable[0].snippet).toBe('key');
  });

  it("records a hard-fail site for `t('a' + b)`", () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ suffix }: { suffix: string }) {
        const { t } = useTranslation('common');
        return <span>{t('prefix.' + suffix)}</span>;
      }
    `);
    expect(analysis.unanalyzable).toHaveLength(1);
  });

  it('does not flag non-i18n calls that happen to have a variable argument', () => {
    const analysis = analyze(`
      export default function Foo({ message }: { message: string }) {
        console.log(message);
        return null;
      }
    `);
    expect(analysis.unanalyzable).toHaveLength(0);
  });
});

describe('scope resolution', () => {
  it('picks the closest enclosing useTranslation when several exist in one file', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export function Outer() {
        const { t } = useTranslation('common');
        return <span>{t('outer.label')}</span>;
      }
      export function Inner() {
        const { t } = useTranslation('feed');
        return <span>{t('inner.label')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('common')?.has('outer.label')).toBe(true);
    expect(analysis.usedKeys.get('feed')?.has('inner.label')).toBe(true);
    expect(analysis.usedKeys.get('feed')?.has('outer.label')).toBeFalsy();
    expect(analysis.usedKeys.get('common')?.has('inner.label')).toBeFalsy();
  });
});

describe('conditional / logical t() arguments', () => {
  it('records both branches of a ternary with string-literal sides', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ flag }: { flag: boolean }) {
        const { t } = useTranslation('common');
        return <span>{t(flag ? 'pin.success' : 'pin.failed')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('common')?.has('pin.success')).toBe(true);
    expect(analysis.usedKeys.get('common')?.has('pin.failed')).toBe(true);
    expect(analysis.unanalyzable).toHaveLength(0);
  });

  it('records the literal branch of a `value ?? fallback` argument without hard-failing', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ maybeKey }: { maybeKey: string | undefined }) {
        const { t } = useTranslation('common');
        return <span>{t(maybeKey ?? 'header.default')}</span>;
      }
    `);
    expect(analysis.usedKeys.get('common')?.has('header.default')).toBe(true);
    expect(analysis.unanalyzable).toHaveLength(0);
  });

  it('hard-fails a ternary where one branch is not a static expression', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ flag, dyn }: { flag: boolean; dyn: string }) {
        const { t } = useTranslation('common');
        return <span>{t(flag ? 'pin.success' : dyn)}</span>;
      }
    `);
    expect(analysis.usedKeys.get('common')?.has('pin.success')).toBe(true);
    expect(analysis.unanalyzable).toHaveLength(1);
  });
});

describe('*I18nKey property convention', () => {
  it('records the literal value of a `fooI18nKey` property in every namespace', () => {
    const analysis = analyze(
      `
      export const PRESETS = [
        { slug: 'a', titleI18nKey: 'library.smart.fiveStars.title', descriptionI18nKey: 'library.smart.fiveStars.description' },
      ];
    `,
      fakeTsPath,
    );
    const orphans = namespaceOrphans(
      {
        playlists: ['library.smart.fiveStars.title', 'library.smart.fiveStars.description', 'unused'],
      },
      [analysis],
    );
    expect(orphans.map((orphan) => orphan.key)).toEqual(['unused']);
  });

  it('treats `t(obj.fooI18nKey)` reads as resolved (no hard-fail)', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ preset }: { preset: { titleI18nKey: string } }) {
        const { t } = useTranslation('playlists');
        return <span>{t(preset.titleI18nKey)}</span>;
      }
    `);
    expect(analysis.unanalyzable).toHaveLength(0);
  });
});

describe('missing keys (the inverse direction)', () => {
  it('reports the #4416 shape: a session-bound t() reading a key no catalog defines', () => {
    const analysis = analyze(
      `
      import { useTranslation } from 'react-i18next';
      export default function SwipeBoardCarousel() {
        const { t } = useTranslation('session');
        return <button aria-label={t('playView.resetZoom')}>{t('playView.resetZoom')}</button>;
      }
    `,
      mobilePath,
    );
    const missing = missingKeys({ session: ['playView.play', 'playView.pause'], common: ['board.resetZoom'] }, [
      analysis,
    ]);
    expect(missing).toHaveLength(2);
    expect(missing[0].key).toBe('playView.resetZoom');
    expect(missing[0].namespaces).toEqual(['session']);
    expect(missing[0].file).toBe(mobilePath);
    expect(missing[0].line).toBe(5);
  });

  it('reports nothing once the call points at the key that exists', () => {
    const analysis = analyze(
      `
      import { useTranslation } from 'react-i18next';
      export default function SwipeBoardCarousel() {
        const { t } = useTranslation('session');
        const { t: tCommon } = useTranslation('common');
        return <button aria-label={tCommon('board.resetZoom')}>{t('playView.play')}</button>;
      }
    `,
      mobilePath,
    );
    expect(missingKeys({ session: ['playView.play'], common: ['board.resetZoom'] }, [analysis])).toEqual([]);
  });

  it('counts a base key as defined when only its plural variants are in the catalog', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ count }: { count: number }) {
        const { t } = useTranslation('common');
        return <span>{t('ascents.sent', { count })}</span>;
      }
    `);
    expect(missingKeys({ common: ['ascents.sent_one', 'ascents.sent_other'] }, [analysis])).toEqual([]);
  });

  it('counts ordinal plural variants too', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ count }: { count: number }) {
        const { t } = useTranslation('common');
        return <span>{t('place', { count, ordinal: true })}</span>;
      }
    `);
    expect(missingKeys({ common: ['place_ordinal_one', 'place_ordinal_other'] }, [analysis])).toEqual([]);
  });

  it('is lenient about a t() it could not bind: defined in any namespace counts', () => {
    const analysis = analyze(
      `
      import type { TFunction } from 'i18next';
      export function format(t: TFunction) {
        return t('ascents.statusFlash');
      }
    `,
      fakeTsPath,
    );
    expect(missingKeys({ common: ['unrelated'], feed: ['ascents.statusFlash'] }, [analysis])).toEqual([]);
  });

  it('still reports an unbindable t() whose key exists in no namespace at all', () => {
    const analysis = analyze(
      `
      import type { TFunction } from 'i18next';
      export function format(t: TFunction) {
        return t('ascents.statusFlash');
      }
    `,
      fakeTsPath,
    );
    const missing = missingKeys({ common: ['unrelated'], feed: ['other'] }, [analysis]);
    expect(missing).toHaveLength(1);
    expect(missing[0].key).toBe('ascents.statusFlash');
  });

  it('skips template-literal keys entirely — a glob cannot be verified in this direction', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo({ kind }: { kind: string }) {
        const { t } = useTranslation('admin');
        return <span>{t(\`settings.rows.\${kind}.label\`)}</span>;
      }
    `);
    expect(missingKeys({ admin: ['unrelated'] }, [analysis])).toEqual([]);
  });

  it('accepts a key defined in any one of several bound namespaces', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation(['climbs', 'session']);
        return <span>{t('shared.label')}</span>;
      }
    `);
    expect(missingKeys({ climbs: ['other'], session: ['shared.label'] }, [analysis])).toEqual([]);
  });

  it('resolves an explicit ns:key prefix against that namespace', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('common');
        return <span>{t('feed:ascentsFeed.setBy', { name: 'sam' })}</span>;
      }
    `);
    expect(missingKeys({ common: [], feed: ['ascentsFeed.setBy'] }, [analysis])).toEqual([]);
    const missing = missingKeys({ common: ['ascentsFeed.setBy'], feed: [] }, [analysis]);
    expect(missing).toHaveLength(1);
    expect(missing[0].namespaces).toEqual(['feed']);
  });

  it('does not flag a <Trans> whose i18nKey exists, and does flag one whose key does not', () => {
    const good = analyze(`
      import { useTranslation, Trans } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('settings');
        return <Trans i18nKey="account.delete.body" t={t} components={{ strong: <strong /> }} />;
      }
    `);
    expect(missingKeys({ settings: ['account.delete.body'] }, [good])).toEqual([]);

    const bad = analyze(`
      import { useTranslation, Trans } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('settings');
        return <Trans i18nKey="account.delete.missing" t={t} />;
      }
    `);
    const missing = missingKeys({ settings: ['account.delete.body'] }, [bad]);
    expect(missing).toHaveLength(1);
    expect(missing[0].key).toBe('account.delete.missing');
  });

  it('does not flag the *I18nKey property convention when the key exists somewhere', () => {
    const analysis = analyze(
      `
      export const PRESETS = [{ slug: 'a', titleI18nKey: 'library.smart.fiveStars.title' }];
    `,
      fakeTsPath,
    );
    expect(missingKeys({ playlists: ['library.smart.fiveStars.title'], common: [] }, [analysis])).toEqual([]);
  });

  it('reports each distinct call site, not one entry per duplicate key', () => {
    const analysis = analyze(`
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('common');
        return <span>{t('nope.one')}{t('nope.one')}</span>;
      }
    `);
    const missing = missingKeys({ common: ['yes'] }, [analysis]);
    expect(missing).toHaveLength(2);
    expect(missing.map((entry) => entry.column)).toEqual([...new Set(missing.map((entry) => entry.column))]);
  });
});

describe('mobile namespace guard', () => {
  it('flags a file under packages/mobile reading a namespace Metro never bundles', () => {
    const analysis = analyze(
      `
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('marketing');
        return <span>{t('home.hero.title')}</span>;
      }
    `,
      mobilePath,
    );
    const foreign = foreignMobileNamespaces({ [mobilePath]: analysis });
    expect(foreign).toEqual([{ namespace: 'marketing', file: mobilePath }]);
  });

  it('leaves the same namespace alone in a web file', () => {
    const analysis = analyze(
      `
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('marketing');
        return <span>{t('home.hero.title')}</span>;
      }
    `,
      webPath,
    );
    expect(foreignMobileNamespaces({ [webPath]: analysis })).toEqual([]);
  });

  it('accepts the namespaces that are in the mobile bundle', () => {
    const analysis = analyze(
      `
      import { useTranslation } from 'react-i18next';
      export default function Foo() {
        const { t } = useTranslation('common');
        const { t: tSession } = useTranslation('session');
        return <span>{t('board.resetZoom')}{tSession('playView.play')}</span>;
      }
    `,
      mobilePath,
    );
    expect(foreignMobileNamespaces({ [mobilePath]: analysis })).toEqual([]);
  });
});

describe('formatReport exit codes', () => {
  const emptyReport = {
    totalFiles: 1,
    totalKeys: 1,
    totalReferences: 1,
    orphans: [],
    missing: [],
    foreignMobileNamespaces: [],
    unanalyzable: [],
  };

  it('exits 0 and says both directions passed when everything resolves', () => {
    const formatted = formatReport(emptyReport);
    expect(formatted.exitCode).toBe(0);
    expect(formatted.lines.join('\n')).toContain('static key reference(s) resolve to a catalog entry');
  });

  it('exits 1 when a referenced key is missing from every catalog', () => {
    const formatted = formatReport({
      ...emptyReport,
      missing: [{ namespaces: ['session'], key: 'playView.resetZoom', file: mobilePath, line: 5, column: 7 }],
    });
    expect(formatted.exitCode).toBe(1);
    expect(formatted.lines.join('\n')).toContain('session -> playView.resetZoom');
  });

  it('exits 1 when a mobile file reads an unbundled namespace', () => {
    const formatted = formatReport({
      ...emptyReport,
      foreignMobileNamespaces: [{ namespace: 'marketing', file: mobilePath }],
    });
    expect(formatted.exitCode).toBe(1);
    expect(formatted.lines.join('\n')).toContain('not bundled on mobile');
  });
});

describe('executable gate coverage', () => {
  it('discovers every web and mobile source root', () => {
    const files = discoverFiles([appRoot, scriptsRoot, mobileSrcRoot, mobileAppRoot]);
    expect(files.length).toBeGreaterThan(200);
    for (const root of [appRoot, scriptsRoot, mobileSrcRoot, mobileAppRoot]) {
      expect(files.some((file) => file.startsWith(root))).toBe(true);
    }
  });

  it('matches exclusions against the repo-relative path', () => {
    const nestedRoot = join('/build', 'node_modules', 'boardsesh');
    expect(isExcluded(join(nestedRoot, 'packages/web/app/page.tsx'), nestedRoot)).toBe(false);
    expect(isExcluded(join(nestedRoot, 'node_modules/pkg/index.ts'), nestedRoot)).toBe(true);
  });

  it('does not use import.meta.main under the tsx CJS transform', () => {
    const source = readFileSync(join(repoRoot, 'packages/web/scripts/check-orphaned-i18n-keys.ts'), 'utf8');
    expect(source).not.toMatch(/if\s*\(\s*import\.meta\.main\s*\)/);
    expect(source).toMatch(/if\s*\(\s*isEntryPoint\(\)\s*\)/);
  });
});
