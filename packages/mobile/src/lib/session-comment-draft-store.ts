// Local persistence for an in-progress session recap — the free-text notes a
// climber types when ending a session. Ending navigates to the summary screen
// and fires the mutation across an unmount boundary; if the network write drops
// the recap, the summary screen recovers the typed text from this draft so it
// isn't silently lost. Cleared the moment the recap successfully lands (either
// echoed by endSession or saved from the summary editor).
//
// Single-slot by design: only ONE draft is kept at a time, keyed by sessionId.
// Writing a draft for a new session overwrites the previous slot, and a read for
// a different sessionId misses (returns null) rather than returning a stale draft
// from another session.
//
// Backed by **unsecure** AsyncStorage via preference-store, not SecureStore: a
// recap is non-secret and can exceed SecureStore's 2 KB per-value limit
// (SESSION_NOTES_MAX_LENGTH is 2000 chars).
//
// Schema migration note: `getPreference` returns null on a JSON.parse failure,
// but a stale value whose shape no longer matches `SessionCommentDraft` will
// parse and be cast to the wrong type. Bump the key suffix when the shape
// changes so stale values are ignored rather than misread.

import { getPreference, setPreference, removePreference } from './preference-store';

const SESSION_COMMENT_DRAFT_KEY = 'boardsesh_session_comment_draft_v1';

type SessionCommentDraft = {
  sessionId: string;
  comment: string;
  /** Epoch millis write timestamp, for debugging stale drafts. */
  savedAt: number;
};

/** Persist the in-progress recap for a session, overwriting any prior draft. */
export function setDraftComment(sessionId: string, comment: string): Promise<void> {
  return setPreference<SessionCommentDraft>(SESSION_COMMENT_DRAFT_KEY, {
    sessionId,
    comment,
    savedAt: Date.now(),
  });
}

/**
 * Read the stored recap draft for `sessionId`. Returns null when there's no
 * draft or the stored draft belongs to a different session (single-slot).
 */
export async function getDraftComment(sessionId: string): Promise<string | null> {
  const draft = await getPreference<SessionCommentDraft>(SESSION_COMMENT_DRAFT_KEY);
  if (!draft || draft.sessionId !== sessionId) return null;
  return draft.comment;
}

/** Drop the stored recap draft. No-op when the slot is empty. */
export function clearDraftComment(_sessionId: string): Promise<void> {
  return removePreference(SESSION_COMMENT_DRAFT_KEY);
}
