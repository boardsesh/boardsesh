import { useEffect, useState } from 'react';
import { View, TextInput, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Button } from '../Button';
import { Card } from '../Card';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useUpdateSession } from '../../lib/graphql/hooks';
import { getDraftComment, clearDraftComment } from '../../lib/session-comment-draft-store';
import { track } from '../../lib/analytics';
import { spacing, borderRadius } from '../../theme/tokens';

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
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
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

  if (isEditing) {
    return (
      <Card style={styles.card}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('summary.commentLabel')}
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          placeholder={t('summary.commentPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          accessibilityLabel={t('summary.commentLabel')}
          value={draft}
          onChangeText={setDraft}
          maxLength={SESSION_NOTES_MAX_LENGTH}
          multiline
          autoFocus
          textAlignVertical="top"
          onFocus={onEditorFocus}
        />
        <Text variant="caption2" color={systemColors.tertiaryLabel} style={styles.helper}>
          {t('summary.commentHelper', { count: draft.length, max: SESSION_NOTES_MAX_LENGTH })}
        </Text>
        {updateSession.isError ? (
          <Text variant="footnote" color={brandColors.error}>
            {t('summary.recapSaveError')}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button title={tCommon('comment.cancel')} variant="text" onPress={cancelEditing} />
          <Button
            title={tCommon('comment.save')}
            variant="filled"
            loading={updateSession.isPending}
            onPress={handleSave}
          />
        </View>
      </Card>
    );
  }

  // Read mode with a recap: the creator can tap to edit; viewers see it read-only.
  if (hasNotes) {
    return (
      <Card style={styles.card} onPress={editable ? startEditing : undefined}>
        <View style={styles.captionRow}>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('summary.recapTitle')}
          </Text>
          {editable ? <Icon name="edit" size={14} color={systemColors.secondaryLabel} /> : null}
        </View>
        <Text variant="body">{displayedNotes}</Text>
      </Card>
    );
  }

  // Empty + editable: an add-a-recap affordance that opens the inline editor.
  if (editable) {
    return (
      <View style={styles.addRow}>
        <Button title={t('summary.addRecap')} variant="text" icon="add" onPress={startEditing} />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[1],
  },
  input: {
    minHeight: 88,
    maxHeight: 160,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 15,
    marginTop: spacing[1],
  },
  helper: {
    textAlign: 'right',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[1],
  },
  addRow: {
    alignItems: 'flex-start',
    // Cancel the text Button's internal content padding so the + icon lines up
    // with the left content edge of the sibling cards and stat tiles.
    marginLeft: -spacing[4],
  },
  captionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
  },
});
