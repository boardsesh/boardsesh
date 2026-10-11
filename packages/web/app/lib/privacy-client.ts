import type { QueryClient } from '@tanstack/react-query';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './i18n/config';
import { stripLocalePrefix } from './i18n/locale-href';

export const PRIVACY_REVOKED_EVENT = 'boardsesh:privacy-revoked';
const TRANSPORT_QUERY_KEYS = new Set(['wsAuthToken', 'sitePrivacySettings']);

/** Drop copied identity immediately; a stale in-flight response cannot restore it. */
export async function revokeWebPrivacySnapshots(queryClient: QueryClient): Promise<void> {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => !TRANSPORT_QUERY_KEYS.has(String(query.queryKey[0])),
  };
  await queryClient.cancelQueries(filters);
  for (const query of queryClient.getQueryCache().findAll(filters)) {
    query.setState({ data: undefined, dataUpdatedAt: 0, error: null, status: 'pending' });
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PRIVACY_REVOKED_EVENT));
  await queryClient.invalidateQueries(filters);
}

// Pages whose server-rendered markup can carry another account's privacy-gated
// content: walls (including spray views), sessions, profiles, playlists,
// setters, gyms, and climb pages under the board-config routes. React Query
// cannot withdraw that markup, so a privacy event re-renders these pages.
// There is no notifications page to list: the inbox lives in the app, not on
// the website.
const PROTECTED_SECTIONS = new Set(['b', 'session', 'profile', 'playlists', 'setter', 'gym']);
const CLIMB_ROUTE_ACTIONS = new Set(['view', 'play', 'list']);

/** Whether the page at `pathname` server-renders privacy-gated content. */
export function rendersProtectedContentOnServer(pathname: string): boolean {
  let path = pathname;
  for (const locale of SUPPORTED_LOCALES) if (locale !== DEFAULT_LOCALE) path = stripLocalePrefix(path, locale);
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return false;
  if (PROTECTED_SECTIONS.has(segments[0])) return true;
  // /[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/(view|play|list)/...
  return segments.length >= 6 && CLIMB_ROUTE_ACTIONS.has(segments[5]);
}
