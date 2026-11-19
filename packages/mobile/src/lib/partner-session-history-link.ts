import { stripLocalePrefix } from './routing/strip-locale-prefix';

export const PENDING_SESSION_HISTORY_KEY = 'boardsesh_pending_session_history';
const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;
const EXPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isSessionExportId = (exportId: unknown): exportId is string =>
  typeof exportId === 'string' && EXPORT_ID.test(exportId);

/** Only Boardsesh links and local history paths can become a login destination. */
export function parseSessionHistoryExportId(url: string): string | null {
  const path = url
    .replace(/^com\.boardsesh\.app:\/\//, '/')
    .replace(/^https:\/\/(?:www\.|app\.)?boardsesh\.com(?=\/)/, '');
  const normalizedPath = stripLocalePrefix(path) ?? path;
  const match = /^\/history\/session\/([^/?#]+)\/?(?:[?#].*)?$/.exec(normalizedPath);
  return isSessionExportId(match?.[1]) ? match[1] : null;
}

export function serializePendingSessionHistory(exportId: string, now = Date.now()): string {
  return JSON.stringify({ exportId, stashedAt: now });
}

export function readPendingSessionHistory(stored: string | null, now = Date.now()): string | null {
  if (!stored) return null;
  try {
    const candidate: unknown = JSON.parse(stored);
    if (!candidate || typeof candidate !== 'object') return null;
    const { exportId, stashedAt } = candidate as { exportId?: unknown; stashedAt?: unknown };
    if (!isSessionExportId(exportId) || typeof stashedAt !== 'number' || !Number.isFinite(stashedAt)) return null;
    const age = now - stashedAt;
    return age >= 0 && age <= MAX_PENDING_AGE_MS ? exportId : null;
  } catch {
    return null;
  }
}
