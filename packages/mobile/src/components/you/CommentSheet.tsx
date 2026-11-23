import { type RefObject, useState } from 'react';
import type { BottomSheet } from '../sheet-presentation';
import { useTranslation } from 'react-i18next';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { useScopedSheetError } from '../../hooks/use-scoped-sheet-error';
import { usePublicationAudience } from '../privacy/use-publication-audience';
import { PublicationAudiencePicker } from '../privacy/PublicationAudiencePicker';
import { ContentAudienceControl } from '../privacy/ContentAudienceControl';
import { PressableAvatar } from '../PressableAvatar';
import { useComments, useAddComment } from '../../lib/graphql/hooks';
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
  const { submitError, setSubmitError } = useScopedSheetError(`${entityType}:${entityId ?? ''}`, !!entityId);
  const [draft, setDraft] = useState('');
  const privacy = usePublicationAudience(entityId ?? '', !!entityId);

  const commentsQuery = useComments(entityType, entityId ?? undefined, !!entityId);
  const addComment = useAddComment();
  const comments = commentsQuery.data?.comments ?? [];

  const submit = () => {
    const body = draft.trim();
    if (!body || !entityId || addComment.isPending) return;
    setSubmitError(null);
    hapticLight();
    // Clear the draft only once the comment lands. On failure keep the text in
    // the composer and surface an inline error above the native sheet. The send
    // button is disabled while the mutation is pending, so no double-send.
    addComment.mutate(
      { entityType, entityId, body, ...(privacy.publication ? { privacy: privacy.publication } : {}) },
      {
        onSuccess: () => setDraft(''),
        onError: () => setSubmitError(t('mobile.comments.sendError')),
      },
    );
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
      onChangeDraft={(next) => {
        setDraft(next);
        setSubmitError(null);
      }}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}
const renderCommentAvatar = (comment: CommentSheetComment) => (
  <PressableAvatar userId={comment.userId} uri={comment.userAvatarUrl} name={comment.userDisplayName} size={32} />
);
const renderCommentAudience = (comment: CommentSheetComment) => (
  <ContentAudienceControl entityType="comment" entityId={comment.uuid} />
);
