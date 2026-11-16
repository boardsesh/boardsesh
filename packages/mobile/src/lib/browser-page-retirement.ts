/**
 * Native has no browser page to retire: the store build keeps its existing
 * in-place account transitions. Shared callers only reach these inside
 * `Platform.OS === 'web'` branches; the web fork is `browser-page-retirement.web.ts`.
 */
export function isBrowserPageRetired(): boolean {
  return false;
}

export function reloadRetiredBrowserPage(): void {}
