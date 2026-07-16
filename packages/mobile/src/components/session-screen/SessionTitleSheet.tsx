import { useCallback, useEffect, useRef, useState } from 'react';
import { View, KeyboardAvoidingView, StyleSheet } from 'react-native';
import { BottomSheetTextInput } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_NAME_MAX_LENGTH, type SessionDetail } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Sheet } from '../Sheet';
import type { SessionPreview } from '../../lib/graphql/operations';
import { Text } from '../Text';
import { Button } from '../Button';
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

  // Buttons live in the BODY (EndSessionSheet's pattern), not the Sheet footer
  // slot: on Android's M3 sheet a small single detent gets a second expanded
  // state (androidSafeSnapPoints) and the pinned footer lays out against the
  // expanded height — off-screen below the partial sheet (emulator-verified).
  // The KeyboardAvoidingView mirrors EndSessionSheet: the Android dialog window
  // doesn't resize for the keyboard.
  return (
    <Sheet visible={visible} enableDynamicSizing onClose={onClose}>
      <KeyboardAvoidingView behavior="padding">
        <View style={styles.body}>
          <Text variant="title2">{t('mobile.session.renameTitle')}</Text>
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
          <View style={styles.actions}>
            <Button title={tCommon('comment.cancel')} variant="text" onPress={onClose} />
            <Button
              title={t('mobile.session.renameSave')}
              variant="filled"
              loading={updateSession.isPending}
              disabled={!sessionId}
              onPress={handleSave}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
  },
});
