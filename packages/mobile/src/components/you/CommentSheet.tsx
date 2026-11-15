import { InlineSheetError } from '../InlineSheetError';
import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import { PressableSurface } from '../PressableSurface';
import { usePublicationAudience } from '../privacy/use-publication-audience';
import { PublicationAudiencePicker } from '../privacy/PublicationAudiencePicker';
import { ContentAudienceControl } from '../privacy/ContentAudienceControl';
import { type RefObject, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { type BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { PressableAvatar } from '../PressableAvatar';
import { Icon } from '../Icon';
import { Sheet } from '../Sheet';
import { ActivityIndicator } from '../ActivityIndicator';
import { useComments, useAddComment } from '../../lib/graphql/hooks';
import { useHttpActionScope } from '../../lib/graphql/use-http-action-scope';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { hapticLight } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';

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
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
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
    <Sheet
      ref={sheetRef}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      onClose={close}
      footer={
        canComment ? (
          <View>
            <PublicationAudiencePicker privacy={privacy} disabled={addComment.isPending} />
            <View style={styles.composer}>
              <BottomSheetTextInput
                style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
                placeholder={t('mobile.comments.placeholder')}
                placeholderTextColor={systemColors.tertiaryLabel}
                value={draft}
                onChangeText={changeDraft}
                multiline
              />
              <PressableSurface
                onPress={submit}
                disabled={draft.trim().length === 0 || addComment.isPending}
                style={styles.send}
                accessibilityRole="button"
              >
                <Icon
                  name="send.fill"
                  size={22}
                  color={draft.trim().length > 0 ? brandColors.primary : systemColors.tertiaryLabel}
                />
              </PressableSurface>
            </View>
            <InlineSheetError message={submitError} visible={!!entityId} scope={`${entityType}:${entityId ?? ''}`} />
          </View>
        ) : (
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.signInPrompt}>
            {tCommon('comment.signInPrompt')}
          </Text>
        )
      }
    >
      <Text variant="title3" style={styles.title}>
        {t('mobile.comments.title')}
      </Text>
      {commentsQuery.isPending && entityId ? (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      ) : comments.length === 0 ? (
        <Text variant="subheadline" style={styles.empty}>
          {t('mobile.comments.empty')}
        </Text>
      ) : (
        comments.map((comment) => (
          <View key={comment.uuid} style={styles.commentRow}>
            <PressableAvatar
              userId={comment.userId}
              uri={comment.userAvatarUrl}
              name={comment.userDisplayName}
              size={32}
            />
            <View style={styles.commentBody}>
              <View style={styles.commentMeta}>
                <Text variant="subheadline" style={styles.commentName}>
                  {comment.userDisplayName ?? t('mobile.unknownName')}
                </Text>
                <Text variant="caption2" color={systemColors.secondaryLabel}>
                  {formatRelativeTime(comment.createdAt)}
                </Text>
              </View>
              <Text variant="subheadline">{comment.body}</Text>
              <ContentAudienceControl entityType="comment" entityId={comment.uuid} />
            </View>
          </View>
        ))
      )}
    </Sheet>
  );
}

const createStyles = (textStyles: TypographyScale) =>
  StyleSheet.create({
    title: { paddingHorizontal: spacing[4], paddingTop: spacing[2], paddingBottom: spacing[3] },
    centered: { paddingVertical: spacing[10], alignItems: 'center' },
    empty: { paddingHorizontal: spacing[4], paddingVertical: spacing[6], opacity: 0.6 },
    commentRow: {
      flexDirection: 'row',
      gap: spacing[3],
      paddingHorizontal: spacing[4],
      paddingVertical: spacing[2],
    },
    commentBody: { flex: 1, gap: 2 },
    commentMeta: { flexDirection: 'row', alignItems: 'baseline', gap: spacing[2] },
    commentName: { fontWeight: '600' },
    composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing[2] },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      borderRadius: borderRadius.lg,
      paddingHorizontal: spacing[3],
      paddingVertical: spacing[2],
      fontSize: textStyles.subheadline.fontSize,
    },
    send: { paddingBottom: spacing[2] },
    signInPrompt: { paddingVertical: spacing[2], textAlign: 'center' },
  });
