import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, overlays, spacing } from '../../theme/tokens';

type SwitchBoardOverlayProps = {
  /** Human-readable name of the climb's board, e.g. "Kilter". */
  boardLabel: string;
  /** Switch to the climb's board — one-tap when the user owns it, otherwise the
   *  board picker. Provided by DrawerHostProvider. */
  onSwitchBoard: () => void;
};

/**
 * Drawn over the play-drawer control region when the displayed climb belongs to
 * a board that is NOT at the gym the climber is standing in. Viewing (board art
 * + swipe) stays available; the queue / tick / BLE / mirror / favorite controls
 * underneath are blocked, because none of them can reach a board in another
 * building.
 *
 * A climb on a board at THIS gym gets no overlay at all. The climber can walk to
 * it, so it is an ordinary queue item: it renders on its own board, every
 * control stays live, and the lightbulb is what takes them there — pressing it
 * binds that board and connects, which is the same thing a "move to it" prompt
 * would have asked them to confirm first.
 *
 * The message sits on an opaque card rather than straight on the scrim. The
 * scrim alone is a 60% fill, so the controls it covers read right through the
 * words on top of it — the card is what makes them recede. It is NOT glass: the
 * card is content, and HIG Materials keeps Liquid Glass on the controls layer
 * (it used to be a glass card inside the glass player — glass on glass).
 * Everything inside is centred.
 *
 * Uses climb-scoped `session.boardMismatch.*` copy (the playlist-detail screen
 * has its own banner with playlist-worded copy).
 */
export function SwitchBoardOverlay({ boardLabel, onSwitchBoard }: SwitchBoardOverlayProps) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  return (
    <View style={styles.scrim} accessibilityViewIsModal>
      <View testID="switch-board-card" style={[styles.card, { backgroundColor: systemColors.elevatedSurface }]}>
        <Icon name="lock" size={22} color={systemColors.label} />
        <Text variant="headline" color={systemColors.label} style={styles.centered}>
          {t('boardMismatch.title', { board: boardLabel })}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
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
    paddingHorizontal: spacing[4],
  },
  card: {
    alignSelf: 'stretch',
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[4],
    paddingHorizontal: spacing[4],
  },
  centered: {
    textAlign: 'center',
  },
});
