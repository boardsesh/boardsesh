import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #5654, as a text guard over app/_layout.tsx.
//
// Everything below <DatabaseProvider> sits under expo-sqlite's memo()'d
// SQLiteProvider, whose comparator ignores `children`. A RootLayout re-render
// never reaches that subtree, so a prop computed there from anything RootLayout
// holds keeps its first-render value forever. That froze `ready={authReady &&
// fontsReady}` at false for four launch gates from 2.2.0 until #5654.
//
// launch-ready-through-database.test.tsx proves the mechanism with real
// components. This file pins the one place it matters: RootLayout's own JSX.
// Rendering all of RootLayout in a test would need every provider in the app,
// so the source is read as text instead, the same way the sitemap shard
// registry is guarded.
//
// The rule is deliberately broader than "no state below the provider". Any name
// declared in RootLayout's body counts: a derived `const launchReady = authReady
// && fontsReady` one line up reproduces the bug just as well as the state
// itself. The only names allowed through are callbacks whose identity never
// changes, and each of those is checked to really be one.
//
// What a text guard cannot see, so do not lean on it alone. It reads only
// RootLayout: a new wrapper component that renders <DatabaseProvider> with
// children built from its own state has the same bug and passes here. It
// matches names at the formatter's two-space body indent, so it trusts the
// formatter. The real fix is structural: the gates read `useLaunchReady()`
// from a provider above the database instead of taking a prop, and
// launch-ready-through-database.test.tsx renders them through the real
// provider. This file only keeps RootLayout from reintroducing the prop.

const layoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');

/**
 * Names declared in RootLayout that may appear below the provider, because
 * their value never changes after the first render. Each must be a
 * `useCallback` with an empty dependency list; a test below checks that.
 */
const STABLE_ROOT_LAYOUT_BINDINGS = ['onAuthReady'];

/** Drop block and line comments so prose that NAMES the bug cannot trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** RootLayout from its declaration up to its JSX `return (`. */
function rootLayoutSetup(source: string): string {
  const start = source.indexOf('function RootLayout()');
  if (start === -1) throw new Error('RootLayout is no longer declared as `function RootLayout()`; update this guard');
  const jsxReturn = source.indexOf('\n  return (', start);
  if (jsxReturn === -1) throw new Error('RootLayout no longer ends in `return (`; update this guard');
  return source.slice(start, jsxReturn);
}

function databaseProviderSubtree(source: string): string {
  const start = source.indexOf('function RootLayout()');
  const open = source.indexOf('<DatabaseProvider>', start);
  const close = source.indexOf('</DatabaseProvider>', open);
  if (open === -1 || close === -1)
    throw new Error('RootLayout no longer renders <DatabaseProvider>; update this guard');
  return source.slice(open, close);
}

/**
 * Every name declared directly in RootLayout's body: plain bindings, array and
 * object destructuring, and nested functions. "Directly" means two-space
 * indentation, which the formatter guarantees; a `let` inside an effect's
 * callback is deeper and cannot reach the JSX anyway.
 */
function rootLayoutBindings(setup: string): string[] {
  const names = new Set<string>();
  for (const match of setup.matchAll(/^ {2}(?:const|let|var)\s+(\w+)\s*[=:]/gm)) names.add(match[1]);
  for (const match of setup.matchAll(/^ {2}(?:const|let|var)\s+\[([^\]]*)\]\s*=/gm)) {
    for (const element of match[1].split(',')) {
      const bound = element
        .split('=')[0]
        .trim()
        .replace(/^\.\.\./, '');
      if (bound) names.add(bound);
    }
  }
  for (const match of setup.matchAll(/^ {2}(?:const|let|var)\s+\{([^}]*)\}\s*=/gm)) {
    for (const entry of match[1].split(',')) {
      // `{ key: alias = fallback }` binds `alias`; `{ key }` binds `key`.
      const bound = entry
        .split(':')
        .pop()
        ?.split('=')[0]
        .trim()
        .replace(/^\.\.\./, '');
      if (bound) names.add(bound);
    }
  }
  for (const match of setup.matchAll(/^ {2}function\s+(\w+)/gm)) names.add(match[1]);
  return [...names];
}

/** Names from RootLayout's body that the DatabaseProvider subtree mentions, less the stable ones. */
function leakedBindings(source: string): string[] {
  const code = stripComments(source);
  const subtree = databaseProviderSubtree(code);
  return rootLayoutBindings(rootLayoutSetup(code)).filter(
    (name) => !STABLE_ROOT_LAYOUT_BINDINGS.includes(name) && new RegExp(`\\b${name}\\b`).test(subtree),
  );
}

const code = stripComments(layoutSource);

describe('app/_layout.tsx and the SQLiteProvider memo', () => {
  it('still finds what RootLayout declares (else this guard is checking nothing)', () => {
    expect(rootLayoutBindings(rootLayoutSetup(code))).toEqual(
      expect.arrayContaining(['authReady', 'setAuthReady', 'fontsReady', 'setFontsReady', 'onAuthReady']),
    );
  });

  it('passes nothing RootLayout declares to anything inside <DatabaseProvider>', () => {
    const leaked = leakedBindings(layoutSource);
    expect(
      leaked,
      `A value from RootLayout used below <DatabaseProvider> stays at its first-render value (SQLiteProvider's memo ignores children). Share it through a context provided above the provider, like LaunchReadyProvider. Leaked: ${leaked.join(', ')}`,
    ).toEqual([]);
  });

  it.each(STABLE_ROOT_LAYOUT_BINDINGS)('only lets %s through because it is a useCallback with no deps', (name) => {
    // The callback's closing line sits at RootLayout's own indentation.
    const declaration = new RegExp(`\\n {2}const ${name} = useCallback\\([\\s\\S]*?\\n {2}\\}, (\\[[^\\]]*\\])\\);`);
    const match = declaration.exec(rootLayoutSetup(code));
    expect(
      match,
      `${name} is no longer a useCallback declared in RootLayout; revisit STABLE_ROOT_LAYOUT_BINDINGS`,
    ).not.toBeNull();
    expect(match?.[1], `${name} gained dependencies, so its frozen first value can go stale`).toBe('[]');
  });

  it('catches a value derived from state one line up, not only the state itself', () => {
    const derivedLayout = `
function RootLayout() {
  const [authReady, setAuthReady] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const launchReady = authReady && fontsReady;
  const { colorScheme: scheme } = useTheme();

  return (
    <LaunchReadyProvider ready={launchReady}>
      <DatabaseProvider>
        <OnboardingGate ready={launchReady} scheme={scheme} />
      </DatabaseProvider>
    </LaunchReadyProvider>
  );
}
`;
    expect(leakedBindings(derivedLayout)).toEqual(['launchReady', 'scheme']);
  });

  it('provides launch readiness above <DatabaseProvider>, wrapping it', () => {
    const provider = code.indexOf('<LaunchReadyProvider ready={authReady && fontsReady}>');
    const providerClose = code.indexOf('</LaunchReadyProvider>');
    expect(provider).toBeGreaterThan(-1);
    expect(provider).toBeLessThan(code.indexOf('<DatabaseProvider>'));
    expect(providerClose).toBeGreaterThan(code.indexOf('</DatabaseProvider>'));
  });

  it.each(['ConnectivityBanner', 'OnboardingGate', 'QaTesterGate', 'SendRecoveryGate'])(
    'mounts %s below the provider, reading readiness from context rather than a prop',
    (gate) => {
      expect(databaseProviderSubtree(code)).toContain(`<${gate} />`);
    },
  );
});
