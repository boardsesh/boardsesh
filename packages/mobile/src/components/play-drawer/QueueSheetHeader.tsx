import { memo, useCallback } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
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
  const { brandColors } = useTheme();

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
          <Pressable
            onPress={onClearAll}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.clear')}
            hitSlop={8}
          >
            <Text variant="body" color={iosSystemColors.systemRed}>
              {t('queueDrawer.clear')}
            </Text>
          </Pressable>
        </View>

        <View style={styles.centerSection}>
          <Text variant="headline">{t('queueDrawer.removeItems', { count: selectedCount })}</Text>
        </View>

        <View style={styles.rightSection}>
          <Pressable
            onPress={handleToggleEdit}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queueSheet.doneEditing')}
            hitSlop={8}
            style={styles.headerButton}
          >
            <Icon name="close" size={18} color={iosSystemColors.systemGray} />
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.leftSection}>
        <Pressable
          onPress={handleToggleHistory}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queueSheet.toggleHistory')}
          hitSlop={8}
          style={[
            styles.headerButton,
            showHistory && styles.headerButtonActive,
            showHistory && { borderColor: brandColors.primary, backgroundColor: `${brandColors.primary}14` },
          ]}
        >
          <Icon name="history" size={22} color={showHistory ? brandColors.primary : iosSystemColors.systemGray} />
        </Pressable>
      </View>

      <View style={styles.centerSection}>
        <Text variant="headline">{t('queueDrawer.title')}</Text>
        {queueCount > 0 && (
          <Text variant="caption1" color={iosSystemColors.systemGray}>
            {t('mobile.queue.climbCount', { count: queueCount })}
          </Text>
        )}
      </View>

      <View style={styles.rightSection}>
        {!viewOnlyMode && (
          <Pressable
            onPress={handleToggleEdit}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queueSheet.editQueue')}
            hitSlop={8}
            style={styles.headerButton}
          >
            <Icon name="edit" size={20} color={iosSystemColors.systemGray} />
          </Pressable>
        )}

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t('playView.closeAria')}
          hitSlop={8}
          style={styles.headerButton}
        >
          <Icon name="chevron.down" size={20} color={iosSystemColors.systemGray} />
        </Pressable>
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
  headerButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: `${iosSystemColors.systemGray}1F`,
  },
  headerButtonActive: {
    borderWidth: 1,
  },
});
