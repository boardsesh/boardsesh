import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { ModalSheet } from '../../ModalSheet';
import { Icon } from '../../Icon';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { RepTimerSettingsCard } from './RepTimerSettingsCard';

type SessionSettingsSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export function SessionSettingsSheet({ visible, onClose }: SessionSettingsSheetProps) {
  const { t } = useTranslation('session');
  const { brandColors } = useTheme();
  const sheetRef = useRef<BottomSheetModal>(null);
  const isPresentedRef = useRef(false);
  const snapPoints = useMemo(() => ['42%', '80%'], []);

  useEffect(() => {
    if (visible && !isPresentedRef.current) {
      sheetRef.current?.present();
      isPresentedRef.current = true;
    } else if (!visible && isPresentedRef.current) {
      sheetRef.current?.dismiss();
      isPresentedRef.current = false;
    }
  }, [visible]);

  const handleDismiss = useCallback(() => {
    isPresentedRef.current = false;
    onClose();
  }, [onClose]);

  return (
    <ModalSheet
      ref={sheetRef}
      snapPoints={snapPoints}
      onDismiss={handleDismiss}
      enablePanDownToClose
      scrollable
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <Icon name="settings" size={22} color={brandColors.primary} />
        <Text variant="title3" style={styles.title}>
          {t('mobile.session.settingsTitle')}
        </Text>
      </View>

      <RepTimerSettingsCard />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[4],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
    paddingBottom: spacing[6],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
    fontWeight: '600',
  },
});
