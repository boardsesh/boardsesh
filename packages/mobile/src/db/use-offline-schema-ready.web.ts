/**
 * Expo-web fork: readiness is always true in the browser.
 *
 * The browser app has no offline SQLite at all. `metro.config.js` aliases
 * `expo-sqlite` to `src/web-shims/sqlite.tsx` (a fake connection whose queries
 * resolve to `[]` and whose writes are no-ops), and `database-provider.web.tsx`
 * renders its children without ever calling `initializeDatabase`. Nothing on web
 * publishes a handle, so the native store would report "not ready" forever and
 * every gate built on it would be permanently off — turning surfaces that render
 * safe empty states today into dead ones.
 *
 * Returning a constant keeps web behaviour byte-for-byte what it is now: the
 * gates pass, the fake database answers, the screens render as before. Wiring
 * real offline storage for the browser (wa-sqlite / OPFS) is a separate job; when
 * it lands, this fork becomes a real subscription instead.
 */
export function useOfflineSchemaReady(): boolean {
  return true;
}
