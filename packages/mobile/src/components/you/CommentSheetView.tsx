import type { ReactNode, RefObject } from 'react';
import type { BottomSheet } from '../sheet-presentation';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AccessibleBottomSheetTextInput as BottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
import { useTypographyStyles, type TypographyScale } from '../../hooks/use-typography-styles';
import type { useComments } from '../../lib/graphql/hooks';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Sheet } from '../Sheet';
import { ActivityIndicator } from '../ActivityIndicator';
import { InlineSheetError } from '../InlineSheetError';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { MEDIUM_LARGE_SNAP_POINTS } from '../sheet-snap-points';
export type CommentSheetComment = NonNullable<ReturnType<typeof useComments>['data']>['comments'][number];
export type CommentSheetViewProps = {
  sheetRef: RefObject<BottomSheet | null>;
  comments: readonly CommentSheetComment[];
  loading: boolean;
  canComment: boolean;
  draft: string;
  isPending: boolean;
  submitError: string | null;
  errorVisible: boolean;
  errorScope: string;
  audiencePicker?: ReactNode;
  renderAvatar: (comment: CommentSheetComment) => ReactNode;
  renderAudienceControl: (comment: CommentSheetComment) => ReactNode;
  formatTime: (createdAt: string) => string;
  onChangeDraft: (draft: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  onPresented?: () => void;
};
export function CommentSheetView({
  sheetRef,
  comments,
  loading,
  canComment,
  draft,
  isPending,
  submitError,
  errorVisible,
  errorScope,
  audiencePicker,
  renderAvatar,
  renderAudienceControl,
  formatTime,
  onChangeDraft,
  onSubmit,
  onClose,
  onPresented,
}: CommentSheetViewProps) {
  const styles = useTypographyStyles(createStyles);
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  return (
    <Sheet
      ref={sheetRef}
      onPresented={onPresented}
      snapPoints={MEDIUM_LARGE_SNAP_POINTS}
      scrollable
      onClose={onClose}
      footer={
        canComment ? (
          <View>
            {audiencePicker}
            <View style={styles.composer}>
              <BottomSheetTextInput
                style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
                placeholder={t('mobile.comments.placeholder')}
                placeholderTextColor={systemColors.tertiaryLabel}
                value={draft}
                onChangeText={onChangeDraft}
                multiline
              />
              <PressableSurface
                onPress={onSubmit}
                disabled={draft.trim().length === 0 || isPending}
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
            <InlineSheetError message={submitError} visible={errorVisible} scope={errorScope} />
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
      {loading ? (
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
            {renderAvatar(comment)}
            <View style={styles.commentBody}>
              <View style={styles.commentMeta}>
                <Text variant="subheadline" style={styles.commentName}>
                  {comment.userDisplayName ?? t('mobile.unknownName')}
                </Text>
                <Text variant="caption2" color={systemColors.secondaryLabel}>
                  {formatTime(comment.createdAt)}
                </Text>
              </View>
              <Text variant="subheadline">{comment.body}</Text>
              {renderAudienceControl(comment)}
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
