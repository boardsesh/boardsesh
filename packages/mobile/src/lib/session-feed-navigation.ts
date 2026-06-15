import { type useRouter } from 'expo-router';
import type { SessionFeedItem } from '@boardsesh/shared-schema';

type Router = ReturnType<typeof useRouter>;

// Session detail lives once per tab stack (Home, Profile) so the push stays inside
// the tab and keeps the native tab bar + bottom accessory on screen. Each feed
// passes the route for its own tab so the detail lands in that tab's back stack.
export type SessionDetailPathname = '/(tabs)/home/session/[sessionId]' | '/(tabs)/profile/session/[sessionId]';

export function navigateToSessionFeedItem(
  router: Router,
  session: SessionFeedItem,
  pathname: SessionDetailPathname,
): void {
  router.push({ pathname, params: { sessionId: session.sessionId } });
}
