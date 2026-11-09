// The open-redirect regression on `+not-found`, driven through Expo Router's own
// URL handling. Only the two hooks the screen reads are faked, and the fake
// `usePathname` returns what the real `getStateFromPath` and
// `getRouteInfoFromState` produced for the URL, against the real route tree in
// `app/`. Whether a redirect leaves the app is decided by the real
// `shouldLinkExternally`, the check `router.replace` runs before `Linking.openURL`.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { INTERNAL_SLOT_NAME } from 'expo-router/build/constants.js';
import { getStateFromPath } from 'expo-router/build/fork/getStateFromPath.js';
import { getRouteInfoFromState } from 'expo-router/build/global-state/getRouteInfoFromState.js';
import { getReactNavigationConfig } from 'expo-router/build/getReactNavigationConfig.js';
import { getRoutes } from 'expo-router/build/getRoutes.js';
import { shouldLinkExternally } from 'expo-router/build/utils/url.js';
import { isReadOnlyAnonymousPath, isSafeReturnPath } from '../../src/lib/routing/read-only-routes';
import { stripLocalePrefix } from '../../src/lib/routing/strip-locale-prefix';

const screen = vi.hoisted(() => ({ pathname: '/' }));

vi.mock('expo-router', () => ({
  Redirect: 'Redirect',
  usePathname: () => screen.pathname,
}));

import NotFound from '../+not-found';

const HOME_TAB = '/(tabs)/home';
const appDirectory = join(__dirname, '..');

function routeFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : routeFilesUnder(entryPath);
    return /\.tsx?$/.test(entry.name) ? [`./${relative(appDirectory, entryPath)}`] : [];
  });
}

type LinkingOptions = Parameters<typeof getStateFromPath>[1];
let linkingOptions: LinkingOptions;

beforeAll(() => {
  const routeFiles = routeFilesUnder(appDirectory);
  const routeContext = Object.assign((_routeFile: string) => ({ default: () => null }), {
    keys: () => routeFiles,
    resolve: (routeFile: string) => routeFile,
    id: 'app',
  });
  const routes = getRoutes(routeContext, { ignoreEntryPoints: true, skipGenerated: true });
  if (!routes) throw new Error('Expected the app directory to produce a route tree');
  linkingOptions = {
    screens: { [INTERNAL_SLOT_NAME]: { path: '', ...getReactNavigationConfig(routes, false) } },
  } as LinkingOptions;
});

/** What the router makes of a URL: the route it lands on and the path it reports. */
function routeFor(url: string) {
  return getRouteInfoFromState(getStateFromPath(url, linkingOptions) as Parameters<typeof getRouteInfoFromState>[0]);
}

/** Render the real screen for `url` and read where its `<Redirect>` points. */
function redirectTargetFor(url: string): string {
  const { pathname, segments } = routeFor(url);
  expect(segments).toEqual(['+not-found']);
  screen.pathname = pathname;
  const { href } = NotFound().props as { href: string };
  return href;
}

describe('+not-found open redirect', () => {
  // Each of these is a real external redirect without the check at the sink. The
  // first assertion pins that: if a router upgrade stops decoding twice, it goes
  // red and says this suite no longer exercises the attack.
  it.each([
    ['the reported link', '/es/%252Fevil.example/x', '//evil.example/x'],
    ['three slashes', '/es/%252F%252Fevil.example/x', '///evil.example/x'],
    [
      'a link shaped to pass the signed-out gate',
      '/es/%252Fevil.example/a/b/c/40/list',
      '//evil.example/a/b/c/40/list',
    ],
  ])('sends %s home instead of off-site', (_label, url, strippedPath) => {
    const stripped = stripLocalePrefix(routeFor(url).pathname);
    expect(stripped).toBe(strippedPath);
    expect(shouldLinkExternally(strippedPath)).toBe(true);

    const href = redirectTargetFor(url);

    expect(href).toBe(HOME_TAB);
    expect(shouldLinkExternally(href)).toBe(false);
  });

  // Not external on this pass, but one more trip through the router decodes them
  // into the shapes above, and browsers read `\` as `/`.
  it.each([
    ['a third encoding layer', '/es/%25252Fevil.example/x'],
    ['an encoded backslash', '/es/%255Cevil.example/x'],
    ['a fourth encoding layer', '/es/%2525252Fevil.example/x'],
    ['an encoded tab', '/es/%2509/evil.example'],
  ])('sends %s home', (_label, url) => {
    expect(redirectTargetFor(url)).toBe(HOME_TAB);
  });

  // The `next` round trip ends at this same screen. A shape check on literal
  // segments cannot see the hidden slash, so the decode-aware check has to.
  it('refuses the next value that reaches this screen after sign-in', () => {
    const next = '/es/%252Fevil.example/a/b/c/40/list';

    expect(isReadOnlyAnonymousPath(next)).toBe(true);
    expect(isSafeReturnPath(next)).toBe(false);
    expect(redirectTargetFor(next)).toBe(HOME_TAB);
  });

  // The reader only gets here if the gate stands aside: a signed-out visitor needs
  // a board-shaped URL. Signed in, every shape arrives.
  it('only reaches a signed-out visitor on a board-shaped URL', () => {
    expect(isReadOnlyAnonymousPath('/es/%252Fevil.example/x')).toBe(false);
    expect(isReadOnlyAnonymousPath('/es/%252Fevil.example/a/b/c/40/list')).toBe(true);
  });
});

describe('+not-found locale retry', () => {
  it.each([
    ['a tuple board link', '/es/kilter/1/10/1,20/40/list', '/kilter/1/10/1,20/40/list'],
    ['a named board link', '/fr/b/the-gym/40/list?utm_source=newsletter', '/b/the-gym/40/list'],
    ['a climb link', '/de/b/the-gym/40/view/some-climb-name', '/b/the-gym/40/view/some-climb-name'],
    ['a setter with a space in the name', '/it/setter/Some%20Climber', '/setter/Some Climber'],
    ['an accented setter name', '/es/setter/Jos%C3%A9', '/setter/José'],
    ['a name with a stray percent sign', '/es/setter/100%25', '/setter/100%'],
  ])('strips the locale from %s and retries the real route', (_label, url, destination) => {
    const href = redirectTargetFor(url);

    expect(href).toBe(destination);
    expect(shouldLinkExternally(href)).toBe(false);
    expect(routeFor(href).segments).not.toEqual(['+not-found']);
  });

  // An unknown path keeps its retry: it fails to match again, then lands on Home.
  it('retries an unknown path without its locale, then lands on Home', () => {
    const retried = redirectTargetFor('/es/no/such/route');

    expect(retried).toBe('/no/such/route');
    expect(redirectTargetFor(retried)).toBe(HOME_TAB);
  });

  it.each(['/no/such/route', '/es', '/estonia/no/such/route'])('sends %s to Home', (url) => {
    expect(redirectTargetFor(url)).toBe(HOME_TAB);
  });
});
