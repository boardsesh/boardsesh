import type { ReactNode } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

export function QueueListBodyView({
  header,
  list,
  undo,
  isEditMode,
  selectedCount,
  bottomInset,
  onRemove,
}: {
  header: ReactNode;
  list: ReactNode;
  undo?: ReactNode;
  isEditMode: boolean;
  selectedCount: number;
  bottomInset: number;
  onRemove: () => void;
}) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const handleBulkRemove = onRemove;
  return (
    <>
      {header}
      {list}
      {undo}

      {isEditMode && selectedCount > 0 && (
        <View
          style={[
            styles.bulkBar,
            {
              paddingBottom: bottomInset + spacing[3],
              backgroundColor: systemColors.background,
              borderTopColor: systemColors.separator,
            },
          ]}
        >
          <PressableSurface
            onPress={handleBulkRemove}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.removeItems', { count: selectedCount })}
            style={styles.bulkButton}
          >
            <Text variant="headline" color={iosSystemColors.white}>
              {t('queueDrawer.removeItems', { count: selectedCount })}
            </Text>
          </PressableSurface>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bulkBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bulkButton: {
    backgroundColor: brandColors.error,
    borderRadius: 12,
    paddingVertical: spacing[3],
    alignItems: 'center',
    justifyContent: 'center',
  },
});
