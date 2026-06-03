import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetBackdrop, BottomSheetView, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { Button } from './Button';
import { Icon } from './Icon';
import { SheetHandle } from './SheetHandle';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';

type EndSessionSheetProps = {
  visible: boolean;
  onDismiss: () => void;
  onConfirm: () => void;
  isEnding: boolean;
  climbCount: number;
};

export function EndSessionSheet({ visible, onDismiss, onConfirm, isEnding, climbCount }: EndSessionSheetProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const sheetRef = useRef<BottomSheet>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
    }
  }, [visible]);

  useEffect(() => {
    if (mounted) {
      sheetRef.current?.expand();
    }
  }, [mounted]);

  const snapPoints = useMemo(() => ['35%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />,
    [],
  );

  const handleClose = useCallback(() => {
    setMounted(false);
    onDismiss();
  }, [onDismiss]);

  const renderHandle = useCallback(() => <SheetHandle onClose={() => sheetRef.current?.close()} />, []);

  if (!mounted) return null;

  return (
    <BottomSheet
      ref={sheetRef}
      snapPoints={snapPoints}
      enablePanDownToClose
      onClose={handleClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: systemColors.secondaryBackground }}
      handleComponent={renderHandle}
    >
      <BottomSheetView style={styles.content}>
        <Icon name="end.session" size={40} color={systemColors.secondaryLabel} />

        <Text variant="title2" style={styles.title}>
          {t('mobile.queue.endSession')}
        </Text>

        <Text variant="body" color={systemColors.secondaryLabel} style={styles.subtitle}>
          {t('mobile.queue.endSessionConfirm')}
        </Text>

        <View style={styles.statRow}>
          <Icon name="tick.outline" size={16} color={systemColors.secondaryLabel} />
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.queue.climbCount', { count: climbCount })}
          </Text>
        </View>

        <View style={styles.buttonRow}>
          <Button title={t('summary.done')} variant="outlined" onPress={handleClose} style={styles.button} />
          <Button title={t('mobile.queue.endSession')} onPress={onConfirm} loading={isEnding} style={styles.button} />
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: spacing[6],
    paddingTop: spacing[4],
    gap: spacing[3],
  },
  title: {
    fontWeight: '600',
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    lineHeight: 20,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing[3],
    marginTop: spacing[4],
    width: '100%',
  },
  button: {
    flex: 1,
  },
});
