import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #5654, as a text guard over app/_layout.tsx.
//
// Everything below <DatabaseProvider> sits under expo-sqlite's memo()'d
// SQLiteProvider, whose comparator ignores `children`. A RootLayout re-render
// never reaches that subtree, so a prop computed there from RootLayout state
// keeps its first-render value forever. That froze `ready={authReady &&
// fontsReady}` at false for four launch gates from 2.2.0 until #5654.
//
// launch-ready-through-database.test.tsx proves the mechanism with real
// components. This file pins the one place it matters: RootLayout's own JSX.
// Rendering all of RootLayout in a test would need every provider in the app,
// so the source is read as text instead, the same way the sitemap shard
// registry is guarded.

const layoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');

/** Drop block and line comments so prose that NAMES the bug cannot trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function rootLayoutBody(source: string): string {
  const start = source.indexOf('function RootLayout()');
  expect(start, 'RootLayout is no longer declared as `function RootLayout()`; update this guard').toBeGreaterThan(-1);
  return source.slice(start);
}

/** Names RootLayout holds in React state; anything derived from them changes over time. */
function rootLayoutStateNames(body: string): string[] {
  return [...body.matchAll(/const \[(\w+),\s*\w+\]\s*=\s*use(?:State|Reducer)\b/g)].map((match) => match[1]);
}

function databaseProviderSubtree(body: string): string {
  const open = body.indexOf('<DatabaseProvider>');
  const close = body.indexOf('</DatabaseProvider>');
  expect(open, 'RootLayout no longer renders <DatabaseProvider>; update this guard').toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return body.slice(open, close);
}

const code = rootLayoutBody(stripComments(layoutSource));

describe('app/_layout.tsx and the SQLiteProvider memo', () => {
  it('still keeps auth and font readiness in RootLayout state (else revisit this guard)', () => {
    expect(rootLayoutStateNames(code)).toEqual(expect.arrayContaining(['authReady', 'fontsReady']));
  });

  it('passes no RootLayout state to anything inside <DatabaseProvider>', () => {
    const subtree = databaseProviderSubtree(code);
    const leaked = rootLayoutStateNames(code).filter((name) => new RegExp(`\\b${name}\\b`).test(subtree));
    expect(
      leaked,
      `RootLayout state used below <DatabaseProvider> stays at its first-render value (SQLiteProvider's memo ignores children). Share it through a context provided above the provider, like LaunchReadyProvider. Leaked: ${leaked.join(', ')}`,
    ).toEqual([]);
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
      const subtree = databaseProviderSubtree(code);
      expect(subtree).toContain(`<${gate} />`);
    },
  );
});
