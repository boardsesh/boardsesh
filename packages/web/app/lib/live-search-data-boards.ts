// Boards whose list stats change underneath the page: MoonBoard (the bypass
// that #6786 replaced) and Woods (only Boardsesh refreshes its stats). Their
// list pages are cached for 15 minutes in both the Next data cache and the CDN.
// Pure module: middleware imports it, so no db or next imports here.
const LIVE_SEARCH_DATA_BOARDS: ReadonlySet<string> = new Set(['moonboard', 'woods']);

export const LIVE_SEARCH_DATA_TTL_SECONDS = 15 * 60;

export function hasLiveSearchData(boardName: string): boolean {
  return LIVE_SEARCH_DATA_BOARDS.has(boardName.toLowerCase());
}
