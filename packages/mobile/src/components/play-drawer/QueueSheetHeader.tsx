import { PressableSurface } from '../PressableSurface';
import { memo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { ChromeIconButton } from '../ChromeIconButton';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { topBarFor } from '../../theme/top-bar';
import { hapticSelection } from '../../lib/haptics';

type QueueSheetHeaderProps = {
  isEditMode: boolean;
  showHistory: boolean;
  selectedCount: number;
  queueCount: number;
  viewOnlyMode: boolean;
  onToggleEditMode: () => void;
  onToggleHistory: () => void;
  onClose: () => void;
  onClearAll: () => void;
};

export const QueueSheetHeader = memo(function QueueSheetHeader({
  isEditMode,
  showHistory,
  selectedCount,
  queueCount,
  viewOnlyMode,
  onToggleEditMode,
  onToggleHistory,
  onClose,
  onClearAll,
}: QueueSheetHeaderProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors, variant } = useTheme();
  const spec = topBarFor(variant);

  const handleToggleHistory = useCallback(() => {
    hapticSelection();
    onToggleHistory();
  }, [onToggleHistory]);

  const handleToggleEdit = useCallback(() => {
    hapticSelection();
    onToggleEditMode();
  }, [onToggleEditMode]);

  if (isEditMode) {
    return (
      <View style={styles.container}>
        <View style={styles.leftSection}>
          <PressableSurface
            onPress={onClearAll}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.clear')}
            hitSlop={8}
          >
            <Text
              variant="label"
              color={systemColors.error}
              numberOfLines={1}
              maxFontSizeMultiplier={spec.labelMaxFontScale}
            >
              {t('queueDrawer.clear')}
            </Text>
          </PressableSurface>
        </View>

        <View style={styles.centerSection}>
          <Text variant="headline">{t('queueDrawer.removeItems', { count: selectedCount })}</Text>
        </View>

        <View style={styles.rightSection}>
          <ChromeIconButton
            icon="close"
            onPress={handleToggleEdit}
            accessibilityLabel={t('mobile.queueSheet.doneEditing')}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.leftSection}>
        {/* A toggle: brand-tinted while the history shows. */}
        <ChromeIconButton
          role="action"
          icon="history"
          onPress={handleToggleHistory}
          accessibilityLabel={t('mobile.queueSheet.toggleHistory')}
          color={showHistory ? brandColors.primary : undefined}
          style={
            showHistory
              ? [
                  styles.headerButtonActive,
                  { borderColor: brandColors.primary, backgroundColor: `${brandColors.primary}14` },
                ]
              : undefined
          }
        />
      </View>

      <View style={styles.centerSection}>
        <Text variant="headline">{t('queueDrawer.title')}</Text>
        {queueCount > 0 && (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.queue.climbCount', { count: queueCount })}
          </Text>
        )}
      </View>

      <View style={styles.rightSection}>
        {!viewOnlyMode && (
          <ChromeIconButton
            role="action"
            icon="edit"
            onPress={handleToggleEdit}
            accessibilityLabel={t('mobile.queueSheet.editQueue')}
          />
        )}

        {/* A chevron, not an xmark: the queue folds back into the player. */}
        <ChromeIconButton icon="chevron.down" onPress={onClose} accessibilityLabel={t('playView.closeAria')} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    minHeight: 48,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 44,
  },
  centerSection: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    minWidth: 44,
    gap: spacing[2],
  },
  headerButtonActive: {
    borderWidth: 1,
  },
});
