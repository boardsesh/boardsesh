import { router, useRouter, type Href, type ImperativeRouter } from 'expo-router';

const TAB_NAMES = new Set(['home', 'climbs', 'record', 'discover', 'profile', 'wall']);
let currentScope: string | null = null;
let rememberedTab: string | null = null;

/** Root modals retain the tab that opened them; Account owns its Settings stack. */
export function publishNavigationScope(segments: readonly string[]): void {
  if (segments[0] === '(tabs)' && TAB_NAMES.has(segments[1] ?? '')) {
    rememberedTab = segments[1] ?? null;
    currentScope = rememberedTab ? `/(tabs)/${rememberedTab}` : null;
  } else if (segments[0] === 'account') {
    currentScope = '/account';
  } else if (segments[0] === 'user-drawer') {
    currentScope = rememberedTab ? `/(tabs)/${rememberedTab}` : null;
  } else {
    currentScope = null;
  }
}

/** Public deep-link URLs stay valid; in-app drilling uses the originating stack. */
export function resolveScopedDestination(href: Href, scope: string | null = currentScope): Href {
  const pathname = typeof href === 'string' ? href : href.pathname;
  if (!scope || !pathname) return href;
  const isSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const isUsers = pathname.startsWith('/users/');
  if (!isSettings && !(isUsers && scope.startsWith('/(tabs)/'))) return href;
  const scopedPath = `${scope}${pathname}`;
  return typeof href === 'string' ? (scopedPath as Href) : ({ ...href, pathname: scopedPath } as Href);
}

const wrappers = new WeakMap<ImperativeRouter, ImperativeRouter>();
function wrapRouter(navigation: ImperativeRouter): ImperativeRouter {
  const existing = wrappers.get(navigation);
  if (existing) return existing;
  const wrapped: ImperativeRouter = {
    ...navigation,
    push: (href, ...options) => navigation.push(resolveScopedDestination(href), ...options),
    navigate: (href, ...options) => navigation.navigate(resolveScopedDestination(href), ...options),
    replace: (href, ...options) => navigation.replace(resolveScopedDestination(href), ...options),
  };
  wrappers.set(navigation, wrapped);
  return wrapped;
}

export const scopedRouter = router ? wrapRouter(router) : router;
export function useScopedRouter(): ImperativeRouter {
  return wrapRouter(useRouter());
}
