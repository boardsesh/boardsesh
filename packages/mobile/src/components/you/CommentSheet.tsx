import { type RefObject, useRef, useState } from 'react';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { usePublicationAudience } from '../privacy/use-publication-audience';
import { PublicationAudiencePicker } from '../privacy/PublicationAudiencePicker';
import { ContentAudienceControl } from '../privacy/ContentAudienceControl';
import { PressableAvatar } from '../PressableAvatar';
import { useComments, useAddComment } from '../../lib/graphql/hooks';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { hapticLight } from '../../lib/haptics';
import { CommentSheetView, type CommentSheetComment } from './CommentSheetView';

type CommentSheetProps = {
  sheetRef: RefObject<BottomSheet | null>;
  /** The commented entity (a session or a tick); `null` while closed. */
  entityId: string | null;
  /** Defaults to `'session'` so existing session call sites stay unchanged. */
  entityType?: SocialEntityType;
  /** When false the composer is swapped for a sign-in prompt. Defaults to true
   *  so the session/tick call sites keep their composer untouched. Playlist
   *  threads are readable while logged out, hence the read-only state. */
  canComment?: boolean;
  onClose: () => void;
};

/** Comment thread for a social entity (session, tick or playlist), with an inline composer. */
export function CommentSheet({
  sheetRef,
  entityId,
  entityType = 'session',
  canComment = true,
  onClose,
}: CommentSheetProps) {
  const { t } = useTranslation('you');
  const privacy = usePublicationAudience(entityId ?? '', !!entityId);

  const commentsQuery = useComments(entityType, entityId ?? undefined, !!entityId);
  const addComment = useAddComment();
  const actionScope = useHttpActionScope();
  const identity = useRef({ entityId, entityType, canComment, view: actionScope.key });
  if (
    identity.current.entityId !== entityId ||
    identity.current.entityType !== entityType ||
    identity.current.canComment !== canComment ||
    identity.current.view !== actionScope.key
  )
    identity.current = { entityId, entityType, canComment, view: actionScope.key };
  const currentIdentity = identity.current;
  const [draftState, setDraftState] = useState<{ identity: typeof currentIdentity; text: string } | null>(null);
  const [errorState, setErrorState] = useState<{ identity: typeof currentIdentity; message: string } | null>(null);
  const draft = draftState?.identity === currentIdentity ? draftState.text : '';
  const submitError = errorState?.identity === currentIdentity ? errorState.message : null;
  const setDraft = (text: string) => setDraftState({ identity: currentIdentity, text });
  const setSubmitError = (message: string | null) =>
    setErrorState(message ? { identity: currentIdentity, message } : null);
  const comments = commentsQuery.data?.comments ?? [];

  const changeDraft = (text: string) => {
    if (identity.current !== currentIdentity) return;
    let action: ReturnType<typeof actionScope.capture>;
    try {
      action = actionScope.capture();
    } catch {
      return;
    }
    try {
      action.assertView();
      setDraft(text);
      setSubmitError(null);
    } finally {
      action.finish();
    }
  };

  const submit = () => {
    const body = draft.trim();
    if (!body || !entityId || !canComment || addComment.isPending || identity.current !== currentIdentity) return;
    let action: ReturnType<typeof actionScope.capture>;
    try {
      action = actionScope.capture();
    } catch {
      return;
    }
    const isCurrent = () => identity.current === currentIdentity && action.isCurrent();
    setSubmitError(null);
    hapticLight();
    // Clear the draft only once the comment lands. On failure keep the text in
    // the composer and surface an inline error above the native sheet. The send
    // button is disabled while the mutation is pending, so no double-send.
    void (async () => {
      let receipt: Awaited<ReturnType<typeof addComment.mutateWithReceipt>> | undefined;
      try {
        receipt = await addComment.mutateWithReceipt(
          { entityType, entityId, body, ...(privacy.publication ? { privacy: privacy.publication } : {}) },
          { signal: action.signal },
        );
        receipt.assertCurrent();
        if (isCurrent()) setDraft('');
      } catch {
        if (isCurrent()) setSubmitError(t('mobile.comments.sendError'));
      } finally {
        receipt?.dispose();
        action.finish();
      }
    })();
  };

  const close = () => {
    if (identity.current !== currentIdentity) return;
    let action: ReturnType<typeof actionScope.capture>;
    try {
      action = actionScope.capture();
    } catch {
      return;
    }
    try {
      action.assertView();
      // A close retires this exact opening immediately, even before its parent
      // clears the entity prop or reopens the same entity.
      identity.current = { ...currentIdentity };
      onClose();
    } finally {
      action.finish();
    }
  };

  return (
    <CommentSheetView
      sheetRef={sheetRef}
      comments={comments}
      loading={commentsQuery.isPending && !!entityId}
      canComment={canComment}
      draft={draft}
      isPending={addComment.isPending}
      submitError={submitError}
      errorVisible={!!entityId}
      errorScope={`${entityType}:${entityId ?? ''}`}
      audiencePicker={<PublicationAudiencePicker privacy={privacy} disabled={addComment.isPending} />}
      renderAvatar={renderCommentAvatar}
      renderAudienceControl={renderCommentAudience}
      formatTime={formatRelativeTime}
      onChangeDraft={changeDraft}
      onSubmit={submit}
      onClose={close}
    />
  );
}
const renderCommentAvatar = (comment: CommentSheetComment) => (
  <PressableAvatar userId={comment.userId} uri={comment.userAvatarUrl} name={comment.userDisplayName} size={32} />
);
const renderCommentAudience = (comment: CommentSheetComment) => (
  <ContentAudienceControl entityType="comment" entityId={comment.uuid} />
);
