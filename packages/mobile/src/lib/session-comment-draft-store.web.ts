import { getPreference, removePreference, setPreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';
import { userScopedStorageKey } from './user-storage-owner.web';

const SESSION_COMMENT_DRAFT_KEY = 'boardsesh_session_comment_draft_v1';

type SessionCommentDraft = {
  sessionId: string;
  comment: string;
  /** Epoch millis write timestamp, for debugging stale drafts. */
  savedAt: number;
};

export function setDraftComment(sessionId: string, comment: string, owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(SESSION_COMMENT_DRAFT_KEY, owner);
  if (!storageKey) return Promise.resolve();
  return setPreference<SessionCommentDraft>(storageKey, {
    sessionId,
    comment,
    savedAt: Date.now(),
  });
}

export async function getDraftComment(sessionId: string, owner?: UserStorageOwner | null): Promise<string | null> {
  const storageKey = userScopedStorageKey(SESSION_COMMENT_DRAFT_KEY, owner);
  if (!storageKey) return null;
  const draft = await getPreference<SessionCommentDraft>(storageKey);
  if (!draft || draft.sessionId !== sessionId) return null;
  return draft.comment;
}

export function clearDraftComment(_sessionId: string, owner?: UserStorageOwner | null): Promise<void> {
  return clearSessionCommentDraft(owner);
}

/** Drop the single recap draft owned by one authenticated browser session. */
export function clearSessionCommentDraft(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(SESSION_COMMENT_DRAFT_KEY, owner);
  return storageKey ? removePreference(storageKey) : Promise.resolve();
}
