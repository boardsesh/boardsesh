import { PressableSurface } from '../PressableSurface';
import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { ChromeIconButton } from '../ChromeIconButton';
import { AppMenu } from '../AppMenu';
import type { AppMenuAction } from '../AppMenu.types';
import { useTheme } from '../../providers/theme-provider';
import type { QueueClearSource } from '../../providers/queue-provider';
import { spacing } from '../../theme/tokens';
import { topBarFor } from '../../theme/top-bar';
import { hapticSelection } from '../../lib/haptics';

/** A row in the header's ⋯ menu. The menu reports a position; the row says what it does. */
type QueueMenuRow = AppMenuAction & { id: 'clearQueue' };

type QueueSheetHeaderProps = {
  isEditMode: boolean;
  showHistory: boolean;
  selectedCount: number;
  queueCount: number;
  viewOnlyMode: boolean;
  /** False under the side panel's "Up next" segment, which already names the list. */
  showTitle?: boolean;
  onToggleEditMode: () => void;
  onToggleHistory: () => void;
  /** Folds the sheet away. The side panel has nothing to close, so it omits it. */
  onClose?: () => void;
  /** The edit mode's Clear and the ⋯ menu's Clear queue; `source` says which. */
  onClearAll: (source: QueueClearSource) => void;
};

export const QueueSheetHeader = memo(function QueueSheetHeader({
  isEditMode,
  showHistory,
  selectedCount,
  queueCount,
  viewOnlyMode,
  showTitle = true,
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

  const handleClearFromEdit = useCallback(() => onClearAll('edit'), [onClearAll]);

  // Clear used to live only behind the pencil, where climbers didn't find it.
  // The ⋯ offers it from the resting header; the pencil keeps reorder and remove.
  const menuRows = useMemo<QueueMenuRow[]>(
    () => [{ id: 'clearQueue', label: t('mobile.queueSheet.clearQueue'), systemIcon: 'trash', destructive: true }],
    [t],
  );
  const handleSelectMenuRow = useCallback(
    (index: number) => {
      if (menuRows[index]?.id === 'clearQueue') onClearAll('menu');
    },
    [menuRows, onClearAll],
  );

  if (isEditMode) {
    return (
      <View style={styles.container}>
        <View style={styles.leftSection}>
          <PressableSurface
            onPress={handleClearFromEdit}
            accessibilityRole="button"
            accessibilityLabel={t('queueDrawer.clear')}
            hitSlop={8}
          >
            <LargeContentViewer title={t('queueDrawer.clear')} onActivate={handleClearFromEdit}>
              <Text
                variant="label"
                color={systemColors.error}
                numberOfLines={1}
                maxFontSizeMultiplier={spec.labelMaxFontScale}
              >
                {t('queueDrawer.clear')}
              </Text>
            </LargeContentViewer>
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

      {/* Three trailing buttons leave the title less room. Like SheetTopBar's title,
          it keeps one line and truncates at large text sizes instead of breaking. */}
      <View style={styles.centerSection}>
        {showTitle ? (
          <Text variant="headline" numberOfLines={1}>
            {t('queueDrawer.title')}
          </Text>
        ) : null}
        {queueCount > 0 && (
          <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={1}>
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

        {/* Shown exactly when the pencil is: an empty queue has nothing to clear,
            and anyone who can reach the edit mode's Clear can reach this one. */}
        {!viewOnlyMode && (
          <AppMenu
            iconName="more"
            // The same 44pt circle (48 on Material) as the glyph buttons beside it.
            iconAppearance={spec.glyphFilled ? 'filled' : 'plain'}
            anchorSize={spec.iconTarget}
            accessibilityLabel={t('mobile.queueSheet.moreActions')}
            actions={menuRows}
            onSelectIndex={handleSelectMenuRow}
          />
        )}

        {/* A chevron, not an xmark: the queue folds back into the player. */}
        {onClose ? (
          <ChromeIconButton icon="chevron.down" onPress={onClose} accessibilityLabel={t('playView.closeAria')} />
        ) : null}
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
