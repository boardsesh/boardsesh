// Canonical https join URL — also the QR payload. Universal Links route this to
// the app (when installed); the web /join page is the fallback. Keep the host in
// sync with the Universal Links config (apex vs www) — see C/web side.
const JOIN_BASE_URL = 'https://www.boardsesh.com/join';

/** Build the shareable https join URL for a session (QR payload + copy/share). */
export function buildSessionShareUrl(sessionId: string): string {
  return `${JOIN_BASE_URL}/${encodeURIComponent(sessionId)}`;
}
