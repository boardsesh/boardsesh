import { type RefObject, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import type { SessionDetail } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Sheet } from '../Sheet';
import { Button } from '../Button';
import { SectionHeader } from '../SectionHeader';
import { useUpdateInferredSession } from '../../lib/graphql/hooks';
import { hapticSuccess, hapticError } from '../../lib/haptics';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';

type SessionEditSheetProps = {
  sheetRef: RefObject<BottomSheet | null>;
  session: SessionDetail | null;
  onClose: () => void;
};

/** Rename / edit the goal of an inferred session the viewer owns. */
export function SessionEditSheet({ sheetRef, session, onClose }: SessionEditSheetProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { showToast } = useToast();
  const updateSession = useUpdateInferredSession(session?.sessionId ?? '');

  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');

  // Re-seed whenever a different session opens the sheet.
  useEffect(() => {
    if (!session) return;
    setName(session.sessionName ?? '');
    setGoal(session.goal ?? '');
  }, [session]);

  const save = () => {
    if (!session || updateSession.isPending) return;
    updateSession.mutate(
      { name: name.trim(), description: goal.trim() },
      {
        onSuccess: () => {
          hapticSuccess();
          showToast(t('mobileDetail.updated'), 'success');
          sheetRef.current?.close();
        },
        onError: () => {
          hapticError();
          showToast(t('mobileDetail.updateError'), 'error');
        },
      },
    );
  };

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={['55%']}
      scrollable
      fullWindowOverlay
      onClose={onClose}
      contentContainerStyle={styles.content}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      footer={
        <Button title={t('mobileDetail.save')} onPress={save} loading={updateSession.isPending} disabled={!session} />
      }
    >
      <Text variant="title3" style={styles.title}>
        {t('mobileDetail.editTitle')}
      </Text>

      <SectionHeader title={t('mobileDetail.nameLabel')} />
      <View style={styles.field}>
        <BottomSheetTextInput
          style={[styles.input, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          placeholderTextColor={systemColors.tertiaryLabel}
          value={name}
          onChangeText={setName}
        />
      </View>

      <SectionHeader title={t('mobileDetail.goalLabel')} />
      <View style={styles.field}>
        <BottomSheetTextInput
          style={[styles.input, styles.multiline, { backgroundColor: systemColors.fill, color: systemColors.label }]}
          placeholderTextColor={systemColors.tertiaryLabel}
          value={goal}
          onChangeText={setGoal}
          multiline
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing[6] },
  title: { paddingHorizontal: spacing[4], paddingTop: spacing[2] },
  field: { paddingHorizontal: spacing[4] },
  input: {
    minHeight: 44,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    fontSize: 16,
  },
  multiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
});
