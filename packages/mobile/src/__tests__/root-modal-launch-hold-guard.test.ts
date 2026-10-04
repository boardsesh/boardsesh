import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #6006, as a text guard over app/_layout.tsx and the route files it names.
//
// The launch update gate may reload the app up to 15 s into a cold start. While
// it decides, a placeholder covers the React root and swallows touches. On iOS
// a route presented as a modal is its own view controller ABOVE that root, so
// the placeholder is underneath it: the screen would be usable, and a reload
// could land mid-tap. A URL can open any such route on a cold start.
//
// So every root route with a modal-style presentation has its default export
// wrapped in `holdUntilLaunchReady`, which shows a spinner until launch is
// ready. This file keeps the next modal route from being added without it.
//
// The source is read as text, the same way root-layout-memo-freeze-guard.test.ts
// reads it: rendering RootLayout would need every provider in the app.
//
// What a text guard cannot see. It trusts `presentation` to be a string literal
// inside the `<Stack.Screen>` it belongs to, and the wrap to be written as
// `export default holdUntilLaunchReady(`. A route that takes its presentation
// from a variable, or re-exports a wrapped component under another shape, needs
// this guard updated alongside it.

const APP_DIR = new URL('../../app/', import.meta.url);
const layoutSource = readFileSync(new URL('_layout.tsx', APP_DIR), 'utf8');

/** Presentations iOS shows as a separate view controller over the presenting one. */
const SEPARATE_VIEW_CONTROLLER_PRESENTATIONS = [
  'modal',
  'transparentModal',
  'containedModal',
  'containedTransparentModal',
  'fullScreenModal',
  'formSheet',
  'pageSheet',
];

/** Drop block and line comments so prose that NAMES a presentation cannot trip the guard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

type DeclaredScreen = { name: string; presentation: string | null };

/** Every `<Stack.Screen name="...">` in a layout, with its literal presentation if it sets one. */
function declaredScreens(source: string): DeclaredScreen[] {
  const code = stripComments(source);
  const screens: DeclaredScreen[] = [];
  // Each element runs from its opening tag to the next one (or the stack's end),
  // which keeps one screen's options from being read as its neighbour's.
  const openings = [...code.matchAll(/<Stack\.Screen\b/g)].map((match) => match.index);
  openings.forEach((start, position) => {
    const end = openings[position + 1] ?? code.indexOf('</Stack>', start);
    const element = code.slice(start, end === -1 ? undefined : end);
    const name = /\bname="([^"]+)"/.exec(element)?.[1];
    if (!name) return;
    screens.push({ name, presentation: /\bpresentation:\s*'([A-Za-z]+)'/.exec(element)?.[1] ?? null });
  });
  return screens;
}

function modalScreens(source: string): DeclaredScreen[] {
  return declaredScreens(source).filter(
    ({ presentation }) => presentation !== null && SEPARATE_VIEW_CONTROLLER_PRESENTATIONS.includes(presentation),
  );
}

/** The file Expo Router loads for a route name, relative to a layout's directory. */
function resolveRouteFile(layoutDirectory: URL, routeName: string): URL | null {
  const candidates = [`${routeName}.tsx`, `${routeName}/_layout.tsx`, `${routeName}/index.tsx`];
  for (const candidate of candidates) {
    // Route names carry literal brackets (`join/[sessionId]`), which a URL
    // would percent-encode: resolve on the filesystem path instead.
    const path = `${fileURLToPath(layoutDirectory)}${candidate}`;
    if (existsSync(path)) return new URL(`file://${path}`);
  }
  return null;
}

function isHeldUntilLaunchReady(routeFile: URL): boolean {
  const code = stripComments(readFileSync(fileURLToPath(routeFile), 'utf8'));
  return /^export default holdUntilLaunchReady\(/m.test(code);
}

const rootModalRoutes = modalScreens(layoutSource);

describe('root modal routes and the launch update gate', () => {
  it('still finds the modal routes app/_layout.tsx declares (else this guard is checking nothing)', () => {
    expect(rootModalRoutes.length).toBeGreaterThan(0);
    // The current set. A route dropping out of this list means either it stopped
    // being a modal, or the parser above stopped seeing it: look before updating.
    expect(rootModalRoutes.map(({ name }) => name).toSorted()).toEqual([
      'boards',
      'join/[sessionId]',
      'moderation',
      'moderation/spray-walls',
      'onboarding',
      'play',
      'qa/brief',
      'qa/pick',
      'send-recovery',
      'share-beta',
      'user-drawer',
    ]);
  });

  it('reads plain screens as not modal, so the list above is not just every screen', () => {
    const plainScreens = declaredScreens(layoutSource).filter(({ presentation }) => presentation === null);
    expect(plainScreens.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['index', '(tabs)', 'auth', 'settings']),
    );
  });

  it.each(rootModalRoutes)('holds $name ($presentation) until launch is ready', ({ name }) => {
    const routeFile = resolveRouteFile(APP_DIR, name);
    expect(
      routeFile,
      `app/_layout.tsx declares the modal route "${name}" but no app/${name}.tsx, app/${name}/_layout.tsx or app/${name}/index.tsx exists; update this guard's route resolution`,
    ).not.toBeNull();
    if (routeFile === null) return;

    expect(
      isHeldUntilLaunchReady(routeFile),
      `The root route "${name}" is presented as a modal, which iOS shows as its own view controller above the launch update placeholder. A URL can open it on a cold start while the gate may still reload the app. Wrap its default export: \`export default holdUntilLaunchReady(${name.split('/').at(-1)}Screen)\` (src/components/launch-update/hold-until-launch-ready.tsx; pass { header: 'visible' } if the root stack shows a header for it).`,
    ).toBe(true);
  });

  it('catches a modal route whose file is not wrapped', () => {
    const layout = `
      <Stack>
        <Stack.Screen name="index" />
        <Stack.Screen name="about" options={{ presentation: 'formSheet', headerShown: false }} />
        <Stack.Screen name="play" options={{ presentation: 'transparentModal' }} />
      </Stack>
    `;
    const found = modalScreens(layout);
    expect(found).toEqual([
      { name: 'about', presentation: 'formSheet' },
      { name: 'play', presentation: 'transparentModal' },
    ]);

    const heldByName = Object.fromEntries(
      found.map(({ name }) => {
        const routeFile = resolveRouteFile(APP_DIR, name);
        return [name, routeFile !== null && isHeldUntilLaunchReady(routeFile)];
      }),
    );
    // app/about.tsx is a real, unwrapped route; app/play.tsx is wrapped.
    expect(heldByName).toEqual({ about: false, play: true });
  });

  it('does not read a presentation named only in a comment', () => {
    const layout = `
      <Stack>
        {/* A plain push, NOT presentation: 'modal' (see docs). */}
        <Stack.Screen name="about" options={{ headerShown: false }} />
      </Stack>
    `;
    expect(modalScreens(layout)).toEqual([]);
  });
});

// Nested stacks. A modal declared inside a tab's own stack is presented the
// same way, so it has the same exposure, but only a hand-typed custom-scheme
// URL reaches these two on a cold start and neither is wrapped today. They are
// pinned so that a NEW nested modal shows up here and gets a decision, rather
// than being added unseen.
const KNOWN_UNHELD_NESTED_MODALS = ['(tabs)/climbs/create', '(tabs)/record/summary'];

/** Every `_layout.tsx` under app/ except the root one, as a path relative to app/. */
const NESTED_LAYOUTS = readdirSync(fileURLToPath(APP_DIR), { recursive: true, encoding: 'utf8' })
  .map((entry) => entry.split(sep).join('/'))
  .filter((entry) => entry.endsWith('/_layout.tsx'))
  .toSorted();

describe('modal routes declared in nested layouts', () => {
  it('still reads the nested layouts it means to (else this guard is checking nothing)', () => {
    expect(NESTED_LAYOUTS).toEqual(
      expect.arrayContaining(['(tabs)/climbs/_layout.tsx', '(tabs)/record/_layout.tsx', 'boards/_layout.tsx']),
    );
    expect(NESTED_LAYOUTS).not.toContain('_layout.tsx');
  });

  it('finds no nested modal beyond the known ones that is not held', () => {
    const unheld: string[] = [];
    for (const layout of NESTED_LAYOUTS) {
      const directory = layout.slice(0, -'_layout.tsx'.length);
      const layoutDirectory = new URL(`file://${fileURLToPath(APP_DIR)}${directory}`);
      const source = readFileSync(`${fileURLToPath(APP_DIR)}${layout}`, 'utf8');
      for (const { name } of modalScreens(source)) {
        const routeFile = resolveRouteFile(layoutDirectory, name);
        if (routeFile === null || !isHeldUntilLaunchReady(routeFile)) unheld.push(`${directory}${name}`);
      }
    }
    expect(
      unheld.toSorted(),
      'A nested layout declares a modal route that is not wrapped in holdUntilLaunchReady. iOS presents it above the launch update placeholder, so decide whether a URL can open it on a cold start: wrap it if so, or add it to KNOWN_UNHELD_NESTED_MODALS with the reason.',
    ).toEqual(KNOWN_UNHELD_NESTED_MODALS);
  });
});
