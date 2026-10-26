import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Text } from '../Text';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { useTheme } from '../../providers/theme-provider';
import { WALL_DISPLAY_HREF } from '../../lib/routing/wall-display-link';
import { spacing } from '../../theme/tokens';

type WallDisplayEntryProps = {
  /** Closes the board sheet; resolves false when the hand-off was abandoned. */
  onBeforeNavigate: () => Promise<boolean>;
};

/**
 * The board sheet's way into the full-screen Wall display, on a tablet only:
 * the display is for an iPad (or Android tablet) mounted at the board, so a
 * phone's sheet stays as it was. The sheet closes first, then the display opens
 * over the tabs.
 */
function WallDisplayEntryComponent({ onBeforeNavigate }: WallDisplayEntryProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { isTablet } = useDeviceLayout();

  const handleOpen = useCallback(() => {
    void onBeforeNavigate().then((sheetClosed) => {
      if (sheetClosed) router.push(WALL_DISPLAY_HREF);
    });
  }, [onBeforeNavigate]);

  if (!isTablet) return null;

  return (
    <View testID="board-sheet-wall-display" style={styles.root}>
      <Button title={t('mobile.boardPresence.wallDisplay.open')} icon="expand" variant="tonal" onPress={handleOpen} />
      <Text variant="footnote" color={systemColors.secondaryLabel}>
        {t('mobile.boardPresence.wallDisplay.openHint')}
      </Text>
    </View>
  );
}

export const WallDisplayEntry = memo(WallDisplayEntryComponent);

const styles = StyleSheet.create({
  root: {
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
  },
});
