import { memo, useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { UserBoard } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useOfflineNudge } from '../../lib/offline-nudges/use-offline-nudge';
import { useConfirmBoardDownload } from '../../offline/use-confirm-board-download';
import type { ToggleSource } from '../../offline/use-board-downloads';

type HeatmapDownloadLineProps = {
  /**
   * The climber's board when it is the one on screen, else null: the download
   * only makes sense for the board they are standing at. With no board the line
   * still says why nothing is drawn, without a button.
   */
  board: UserBoard | null;
  /** Where the download was started from, for the download funnel. */
  source?: ToggleSource;
  /** 1 on the create board, whose status row must keep one line box. */
  numberOfLines?: number;
  testID?: string;
};

/**
 * One line in the legend's slot while the heatmap is on for a board that is not
 * on this phone: why nothing is drawn, and a Download button. It replaces the
 * full nudge card, so the flame can stay lit without the drawer growing a card.
 * Still counted as the `hold_heatmap` nudge surface, so a download from here
 * lands in the same funnel.
 */
export const HeatmapDownloadLine = memo(function HeatmapDownloadLine({
  board,
  source,
  numberOfLines = 2,
  testID,
}: HeatmapDownloadLineProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { confirmAndDownload } = useConfirmBoardDownload();
  const nudge = useOfflineNudge({ surface: 'hold_heatmap', board });

  // Accept only once the size dialog said yes, like every other nudge surface.
  const handleDownload = useCallback(() => {
    if (!board) return;
    void confirmAndDownload(board, { trigger: 'hold_heatmap', ...(source ? { source } : {}) }).then((confirmed) => {
      if (confirmed && nudge.visible) nudge.accept('download');
    });
  }, [board, source, nudge, confirmAndDownload]);

  if (!board) {
    return (
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={numberOfLines} testID={testID}>
        {t('mobile.heatmap.needsDownload')}
      </Text>
    );
  }

  return (
    <View style={styles.row} testID={testID}>
      <Text variant="caption1" color={systemColors.secondaryLabel} numberOfLines={numberOfLines} style={styles.text}>
        {t('mobile.heatmap.downloadLine', { name: board.name })}
      </Text>
      <Pressable
        onPress={handleDownload}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.heatmap.download')}
        hitSlop={12}
        style={({ pressed }) => pressed && styles.pressed}
      >
        <Text variant="caption1" color={brandColors.primary} style={styles.action}>
          {t('mobile.heatmap.download')}
        </Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  text: {
    flexShrink: 1,
  },
  action: {
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
});
