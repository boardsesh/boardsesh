import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useEffect, useState } from 'react';
import { track } from '../../lib/analytics';
import { useUpdateSession } from '../../lib/graphql/hooks';
import { clearDraftComment, getDraftComment } from '../../lib/session-comment-draft-store';
import { SessionRecapCardView } from './SessionRecapCardView';

type SessionRecapCardProps = {
  sessionId: string;
  /** Server-persisted recap, if any. */
  notes?: string | null;
  /** Whether the viewer can edit the recap (the session creator). Read-only otherwise. */
  editable?: boolean;
  /**
   * Fired when the inline editor's input gains focus. The summary screen uses
   * it to scroll the editor (and its Save/Cancel row) above the keyboard —
   * automaticallyAdjustKeyboardInsets is an iOS-only no-op.
   */
  onEditorFocus?: () => void;
};

/**
 * The end-of-session recap on the summary screen. Read-only for viewers; the
 * creator can add or edit the notes inline. This is a route (not a native
 * sheet), so it uses a plain RN TextInput and shows inline save feedback — a
 * toast would render behind the modal route.
 */
export function SessionRecapCard({ sessionId, notes, editable = false, onEditorFocus }: SessionRecapCardProps) {
  const updateSession = useUpdateSession();

  // Optimistic copy so the card flips to read mode with the saved text before
  // the invalidated summary query refetches.
  const [savedNotes, setSavedNotes] = useState<string | null>(null);
  const displayedNotes = savedNotes ?? notes ?? null;
  const hasNotes = !!displayedNotes && displayedNotes.trim().length > 0;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Seed the editor from a locally-saved draft when there's no server recap yet,
  // so a recap typed on the end sheet that failed to persist isn't lost.
  useEffect(() => {
    if (!editable || hasNotes) return undefined;
    let active = true;
    void getDraftComment(sessionId).then((stored) => {
      if (active && stored) setDraft(stored);
    });
    return () => {
      active = false;
    };
  }, [sessionId, editable, hasNotes]);

  const startEditing = () => {
    setDraft(displayedNotes ?? draft);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    updateSession.reset();
  };

  const handleSave = () => {
    const trimmed = draft.trim();
    updateSession.mutate(
      { input: { sessionId, notes: trimmed } },
      {
        onSuccess: (result) => {
          setSavedNotes(result.notes ?? (trimmed || null));
          setIsEditing(false);
          void clearDraftComment(sessionId);
          if (trimmed.length > 0) {
            track(SHARED_EVENTS.SessionCommentAdded, { source: 'summary', commentLength: trimmed.length });
          }
        },
      },
    );
  };

  return (
    <SessionRecapCardView
      displayedNotes={displayedNotes}
      editable={editable}
      isEditing={isEditing}
      draft={draft}
      pending={updateSession.isPending}
      error={updateSession.isError}
      onChangeDraft={setDraft}
      onEdit={startEditing}
      onCancel={cancelEditing}
      onSave={handleSave}
      onEditorFocus={onEditorFocus}
    />
  );
}
