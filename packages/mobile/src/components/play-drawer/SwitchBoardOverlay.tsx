import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { withAlpha } from '../../theme/colors';
import { borderRadius, overlays, spacing } from '../../theme/tokens';

type SwitchBoardOverlayProps = {
  /** Human-readable name of the climb's board, e.g. "Kilter". */
  boardLabel: string;
  /** Switch to the climb's board — one-tap when the user owns it, otherwise the
   *  board picker. Provided by DrawerHostProvider. */
  onSwitchBoard: () => void;
};

/**
 * Grey scrim drawn over the play-drawer control region when the displayed climb
 * belongs to a board the user isn't currently on. Viewing (board art + swipe)
 * stays available above the scrim; the queue / tick / BLE / mirror / favorite
 * controls underneath are blocked until the user switches boards — because the
 * queue, LEDs, and ticks all follow the single active board.
 *
 * Uses climb-scoped `session.boardMismatch.*` copy (the playlist-detail screen
 * has its own banner with playlist-worded copy).
 */
export function SwitchBoardOverlay({ boardLabel, onSwitchBoard }: SwitchBoardOverlayProps) {
  const { t } = useTranslation('session');
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <View style={styles.card}>
        <Icon name="lock" size={22} color={overlays.onScrim} />
        <Text variant="headline" color={overlays.onScrim} style={styles.title}>
          {t('boardMismatch.title', { board: boardLabel })}
        </Text>
        <Text variant="subheadline" color={withAlpha(overlays.onScrim, 0.82)} style={styles.subtitle}>
          {t('boardMismatch.subtitle', { board: boardLabel })}
        </Text>
        <Button title={t('boardMismatch.cta')} icon="transfer" variant="filled" size="medium" onPress={onSwitchBoard} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 3,
    backgroundColor: overlays.scrim,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[5],
  },
  card: {
    alignItems: 'center',
    gap: spacing[2],
    borderRadius: borderRadius.lg,
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    marginBottom: spacing[1],
  },
});
