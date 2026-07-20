import { WEB_BASE_URL } from './env';

// Canonical https join URL — also the QR payload. Universal Links route this to
// the app (when installed); the web /join page is the fallback. It follows
// WEB_BASE_URL (EXPO_PUBLIC_WEB_URL) so a staging or self-hosted build hands out
// invites to its own deployment instead of production. Keep the default host in
// sync with the Universal Links config (apex vs www) — see the associatedDomains
// and intentFilters in app.config.ts.
const JOIN_PATH = '/join';

/** Build the shareable https join URL for a session (QR payload + copy/share). */
export function buildSessionShareUrl(sessionId: string): string {
  return `${WEB_BASE_URL}${JOIN_PATH}/${encodeURIComponent(sessionId)}`;
}
