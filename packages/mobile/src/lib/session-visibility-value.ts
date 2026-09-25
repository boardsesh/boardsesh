// The stored shape behind session-store's getStoredSessionVisibility/set, kept
// out of both session-store forks so they read and write the same format.

export function serializeSessionVisibility(sessionId: string, isPublic: boolean): string {
  return JSON.stringify({ sessionId, isPublic });
}

/** The stored value for `sessionId`, or null when the slot is empty, malformed or for another session. */
export function parseStoredSessionVisibility(raw: string | null, sessionId: string): boolean | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const stored = parsed as { sessionId?: unknown; isPublic?: unknown };
  if (stored.sessionId !== sessionId || typeof stored.isPublic !== 'boolean') return null;
  return stored.isPublic;
}
