import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { ButtonSurfaceProvider } from '../Button.surface';
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
  /**
   * `lock` — the climb's board is somewhere else entirely. Nothing here can draw
   * it, light it or tick it, so the scrim is the honest answer.
   *
   * `move` — the climb's board is another board at the gym the climber is
   * standing in. They can walk to it, so this invites rather than blocks: no
   * scrim, no lock, and the controls underneath stay live.
   */
  variant?: 'lock' | 'move';
  /** `move` only: advance past this climb without switching boards. */
  onSkip?: () => void;
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
export function SwitchBoardOverlay({ boardLabel, onSwitchBoard, variant = 'lock', onSkip }: SwitchBoardOverlayProps) {
  const { t } = useTranslation('session');
  if (variant === 'move') {
    return <MoveToWallCallout boardLabel={boardLabel} onSwitchBoard={onSwitchBoard} onSkip={onSkip} />;
  }
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
        <ButtonSurfaceProvider surface="content">
          <Button
            title={t('boardMismatch.cta')}
            icon="transfer"
            variant="filled"
            size="medium"
            onPress={onSwitchBoard}
          />
        </ButtonSurfaceProvider>
      </View>
    </View>
  );
}

/**
 * The same fact as the scrim — this climb belongs to another board — told as an
 * invitation instead of a refusal.
 *
 * The scrim's premise is "you are on the wrong board and can do nothing here".
 * At a gym with two boards that is simply false: the climber queued from both on
 * purpose, the other one is across the room, and the queue, the tick and the
 * swipe all still work on the climb in front of them. Only the LEDs genuinely
 * can't reach, and the wall controls degrade on their own.
 *
 * So: no scrim, no lock glyph, nothing underneath is blocked, and there are
 * three ways out rather than one — go there, skip it, or ignore this and keep
 * browsing.
 */
function MoveToWallCallout({
  boardLabel,
  onSwitchBoard,
  onSkip,
}: Pick<SwitchBoardOverlayProps, 'boardLabel' | 'onSwitchBoard' | 'onSkip'>) {
  const { t } = useTranslation('session');
  // Static tokens, like the scrim above, rather than the theme provider: the
  // callout sits over board art and needs the same on-scrim treatment either
  // way, and this file is rendered by harnesses that mock react-native narrowly.
  return (
    <View style={styles.callout}>
      <View style={styles.calloutText}>
        <Text variant="subheadline" color={overlays.onScrim}>
          {t('mobile.boardPresence.moveToWall.title', { board: boardLabel })}
        </Text>
        <Text variant="caption1" color={withAlpha(overlays.onScrim, 0.82)}>
          {t('mobile.boardPresence.moveToWall.body')}
        </Text>
      </View>
      <View style={styles.calloutActions}>
        <Button
          title={t('mobile.boardPresence.moveToWall.cta', { board: boardLabel })}
          icon="transfer"
          variant="filled"
          size="small"
          onPress={onSwitchBoard}
        />
        {onSkip ? (
          <Button
            title={t('mobile.boardPresence.moveToWall.skip')}
            accessibilityLabel={t('mobile.boardPresence.moveToWall.skipAria', { board: boardLabel })}
            variant="text"
            size="small"
            onPress={onSkip}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  callout: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    bottom: spacing[3],
    zIndex: 3,
    gap: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.lg,
    backgroundColor: overlays.scrim,
  },
  calloutText: {
    gap: spacing[1] / 2,
  },
  calloutActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
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
