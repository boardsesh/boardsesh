import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { SESSION_NAME_MAX_LENGTH, SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Sheet } from '../Sheet';
import { Text } from '../Text';
import { Button } from '../Button';
import { useTheme } from '../../providers/theme-provider';
import { useUpdateSession } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { hapticSuccess } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';

// After a successful save the sheet shows the "Session updated" line briefly, then
// closes — long enough to register, short enough not to stall the flow.
const SAVED_CLOSE_DELAY_MS = 1200;

type SessionEditSheetProps = {
  /** Controlled visibility. */
  visible: boolean;
  /** The session being edited; null disables the save. */
  sessionId: string | null;
  /** Current server title (seeds the name field). */
  currentName?: string | null;
  /** Current server recap (seeds the recap field). */
  currentNotes?: string | null;
  onClose: () => void;
};

// Normalize a field to its canonical value: a trimmed non-empty string, or null.
// Used both to detect a change and to build the mutation payload (null clears).
function normalize(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Owner-only post-hoc editing of a past session's name and recap on the detail
 * screen. Seeds both fields from the server values on each open, saves only the
 * fields that actually changed (the `updateSession` input distinguishes an
 * omitted field from an explicit null), and shows inline success / failure — a
 * toast would render behind the native sheet. The mutation hook invalidates the
 * session's detail + feeds, so the screen refreshes on its own.
 */
export function SessionEditSheet({ visible, sessionId, currentName, currentNotes, onClose }: SessionEditSheetProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const updateSession = useUpdateSession();

  const [name, setName] = useState('');
  const [recap, setRecap] = useState('');
  const [justSaved, setJustSaved] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Seed both fields from the server values on each closed→open transition.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setName(currentName ?? '');
      setRecap(currentNotes ?? '');
      setJustSaved(false);
      updateSession.reset();
    }
    wasVisibleRef.current = visible;
  }, [visible, currentName, currentNotes, updateSession]);

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const handleChangeName = useCallback(
    (text: string) => {
      if (updateSession.isError) updateSession.reset();
      setName(text);
    },
    [updateSession],
  );

  const handleChangeRecap = useCallback(
    (text: string) => {
      if (updateSession.isError) updateSession.reset();
      setRecap(text);
    },
    [updateSession],
  );

  const handleSave = useCallback(() => {
    if (!sessionId) return;
    const nextName = normalize(name);
    const nextNotes = normalize(recap);
    const nameChanged = nextName !== normalize(currentName ?? '');
    const notesChanged = nextNotes !== normalize(currentNotes ?? '');

    // Nothing to persist — just dismiss.
    if (!nameChanged && !notesChanged) {
      onClose();
      return;
    }

    // Only send the fields that changed: an omitted field is left untouched
    // server-side, while an explicit null clears it.
    const input: { sessionId: string; name?: string | null; notes?: string | null } = { sessionId };
    if (nameChanged) input.name = nextName;
    if (notesChanged) input.notes = nextNotes;

    updateSession.mutate(
      { input },
      {
        onSuccess: () => {
          hapticSuccess();
          if (nameChanged) {
            track(SHARED_EVENTS.SessionRenamed, {
              source: 'session_detail',
              nameLength: nextName?.length ?? 0,
            });
          }
          setJustSaved(true);
          clearCloseTimer();
          closeTimerRef.current = setTimeout(() => {
            closeTimerRef.current = null;
            onClose();
          }, SAVED_CLOSE_DELAY_MS);
        },
      },
    );
  }, [sessionId, name, recap, currentName, currentNotes, updateSession, onClose, clearCloseTimer]);

  // Buttons live in the BODY, not the Sheet footer slot: on Android's M3 sheet
  // the pinned footer lays out against the expanded height and lands off-screen
  // below the partial sheet (emulator-verified; see SessionTitleSheet).
  return (
    <Sheet visible={visible} snapPoints={['70%']} scrollable onClose={onClose}>
      <View style={styles.body}>
        <Text variant="title2">{t('detail.editSession')}</Text>

        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
          {t('detail.editNameLabel')}
        </Text>
        <BottomSheetTextInput
          value={name}
          onChangeText={handleChangeName}
          placeholder={t('creation.form.sessionNamePlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={SESSION_NAME_MAX_LENGTH}
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          returnKeyType="done"
        />

        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.label}>
          {t('detail.editRecapLabel')}
        </Text>
        <BottomSheetTextInput
          value={recap}
          onChangeText={handleChangeRecap}
          placeholder={t('summary.commentPlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={SESSION_NOTES_MAX_LENGTH}
          multiline
          style={[styles.input, styles.multiline, { backgroundColor: systemColors.fill, color: systemColors.label }]}
        />
        <Text variant="caption2" color={systemColors.tertiaryLabel} style={styles.counter}>
          {t('summary.commentHelper', { count: recap.length, max: SESSION_NOTES_MAX_LENGTH })}
        </Text>

        {justSaved ? (
          <Text variant="footnote" color={brandColors.success} style={styles.feedback}>
            {t('detail.editSaved')}
          </Text>
        ) : updateSession.isError ? (
          <Text variant="footnote" color={brandColors.error} style={styles.feedback}>
            {t('detail.editSaveFailed')}
          </Text>
        ) : null}

        <View style={styles.actions}>
          <Button title={t('detail.editCancel')} variant="text" onPress={onClose} />
          <Button
            title={t('detail.editSave')}
            variant="filled"
            loading={updateSession.isPending}
            disabled={!sessionId || justSaved}
            onPress={handleSave}
          />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[2],
  },
  label: {
    fontWeight: '600',
    marginTop: spacing[2],
  },
  input: {
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  counter: {
    textAlign: 'right',
    marginTop: -spacing[1],
  },
  feedback: {
    marginTop: spacing[2],
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
  },
});
