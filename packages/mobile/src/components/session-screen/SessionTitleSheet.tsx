import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_NAME_MAX_LENGTH, type SessionDetail } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Sheet } from '../Sheet';
import type { SessionPreview } from '../../lib/graphql/operations';
import { Text } from '../Text';
import { SheetTopBar } from '../SheetTopBar';
import { useTheme } from '../../providers/theme-provider';
import { useUpdateSession } from '../../lib/graphql/hooks';
import { track } from '../../lib/analytics';
import { hapticSuccess } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';

type SessionTitleSheetProps = {
  /** Controlled visibility. */
  visible: boolean;
  /** The session being renamed; null disables the save. */
  sessionId: string | null;
  /** The session's current title (server value), used to seed the input on open. */
  currentName?: string | null;
  onClose: () => void;
};

/**
 * Rename the active session from the Record screen. One single-line input seeded
 * from the current title on each closed→open transition. Saving writes the new
 * name through the creator-only `updateSession` mutation (an empty value clears
 * it back to the default "Session" title), optimistically patches the
 * `sessionDetail` cache so the chrome updates instantly (the 30s staleTime would
 * otherwise leave the old title on screen), and closes. Failures surface inline —
 * a toast would render behind the native sheet.
 */
export function SessionTitleSheet({ visible, sessionId, currentName, onClose }: SessionTitleSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const queryClient = useQueryClient();
  const updateSession = useUpdateSession();

  const [name, setName] = useState('');

  // Seed the field from the current title each time the sheet opens; the Sheet is
  // driven declaratively off `visible`, so track only the closed→open transition.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setName(currentName ?? '');
      updateSession.reset();
    }
    wasVisibleRef.current = visible;
  }, [visible, currentName, updateSession]);

  const handleChange = useCallback(
    (text: string) => {
      if (updateSession.isError) updateSession.reset();
      setName(text);
    },
    [updateSession],
  );

  const handleSave = useCallback(() => {
    if (!sessionId) return;
    const trimmed = name.trim();
    updateSession.mutate(
      { input: { sessionId, name: trimmed.length > 0 ? trimmed : null } },
      {
        onSuccess: (updated) => {
          // The chrome reads the title from the sessionPreview cache first
          // (sessionDetail is null until the first tick), falling back to
          // sessionDetail. Patch both in place so the header flips immediately
          // instead of waiting out their staleTimes.
          queryClient.setQueryData<SessionPreview | null>(['sessionPreview', sessionId], (prev) =>
            prev ? { ...prev, name: updated.name ?? null } : prev,
          );
          queryClient.setQueryData<SessionDetail>(['sessionDetail', sessionId], (prev) =>
            prev ? { ...prev, sessionName: updated.name } : prev,
          );
          hapticSuccess();
          track(SHARED_EVENTS.SessionRenamed, { source: 'record_chrome', nameLength: trimmed.length });
          onClose();
        },
      },
    );
  }, [sessionId, name, updateSession, queryClient, onClose]);

  const header = (
    <SheetTopBar
      title={t('mobile.session.renameTitle')}
      leading={{ kind: 'cancel', onPress: onClose, accessibilityLabel: tCommon('comment.cancel') }}
      trailing={{
        label: t('mobile.session.renameSave'),
        onPress: handleSave,
        loading: updateSession.isPending,
        disabled: !sessionId,
        prominent: true,
      }}
    />
  );

  // The header makes the Sheet wrap its body in a column padded by the keyboard
  // overlap, so the field stays above the keyboard without padding of our own. `androidContentSized`
  // keeps that wrapper content-fitted on Android, where a flex-1 column inside
  // a content-sized host collapses to zero height.
  return (
    <Sheet visible={visible} enableDynamicSizing androidContentSized onClose={onClose} header={header}>
      <View style={styles.body}>
        <BottomSheetTextInput
          value={name}
          onChangeText={handleChange}
          placeholder={t('creation.form.sessionNamePlaceholder')}
          placeholderTextColor={systemColors.tertiaryLabel}
          maxLength={SESSION_NAME_MAX_LENGTH}
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          returnKeyType="done"
          autoFocus
          onSubmitEditing={handleSave}
        />
        {updateSession.isError ? (
          <Text variant="footnote" color={brandColors.error} style={styles.error}>
            {/* The server rejects non-creators; "try again" would mislead them. */}
            {updateSession.error instanceof Error && updateSession.error.message.includes('creator')
              ? t('mobile.session.renameNotAllowed')
              : t('mobile.session.renameError')}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    gap: spacing[3],
  },
  input: {
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    fontSize: 16,
  },
  error: {
    marginTop: -spacing[1],
  },
});
