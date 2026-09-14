import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { ButtonSurfaceProvider } from '../Button.surface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { ActionButton } from '../drawer-action-bar/DrawerActionBar';
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
  /** `move` only: step back through the queue without switching boards. */
  onPrevious?: () => void;
  /** `move` only: step forward past this climb without switching boards. */
  onNext?: () => void;
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
export function SwitchBoardOverlay({
  boardLabel,
  onSwitchBoard,
  variant = 'lock',
  onPrevious,
  onNext,
}: SwitchBoardOverlayProps) {
  const { t } = useTranslation('session');
  if (variant === 'move') {
    return (
      <MoveToWallCallout
        boardLabel={boardLabel}
        onSwitchBoard={onSwitchBoard}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    );
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
  onPrevious,
  onNext,
}: Pick<SwitchBoardOverlayProps, 'boardLabel' | 'onSwitchBoard' | 'onPrevious' | 'onNext'>) {
  const { t } = useTranslation('session');
  // Static tokens, like the scrim above, rather than the theme provider: the
  // callout sits over board art and needs the same on-scrim treatment either
  // way, and this file is rendered by harnesses that mock react-native narrowly.
  return (
    <GlassSurface style={styles.callout} borderRadius={borderRadius.lg} glassEffectStyle="regular">
      <View style={styles.calloutText}>
        <Text variant="subheadline" color={overlays.onScrim} style={styles.calloutCentered}>
          {t('mobile.boardPresence.moveToWall.title', { board: boardLabel })}
        </Text>
        <Text variant="caption1" color={withAlpha(overlays.onScrim, 0.82)} style={styles.calloutCentered}>
          {t('mobile.boardPresence.moveToWall.body')}
        </Text>
      </View>
      {/* Stepping past this climb uses the drawer's own transport glyphs, in its
          own button style, so the gesture reads the same here as it does in the
          control row underneath. Walking to the other board is the offer; moving
          along the queue is still just moving along the queue. */}
      <View style={styles.calloutActions}>
        {onPrevious ? (
          <ActionButton
            size="sm"
            iconName="skip.previous"
            onPress={onPrevious}
            accessibilityLabel={t('playView.actionBar.previousAria')}
          />
        ) : null}
        <Button
          title={t('mobile.boardPresence.moveToWall.cta', { board: boardLabel })}
          icon="transfer"
          variant="filled"
          size="small"
          onPress={onSwitchBoard}
        />
        {onNext ? (
          <ActionButton
            size="sm"
            iconName="skip.next"
            onPress={onNext}
            accessibilityLabel={t('playView.actionBar.nextAria')}
          />
        ) : null}
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  callout: {
    // Glass laid over the controls rather than a panel pushing them down: the
    // board art keeps its height, and the controls stay legible-but-recessed
    // underneath instead of bleeding through a flat scrim.
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    bottom: spacing[3],
    zIndex: 3,
    gap: spacing[2],
    paddingVertical: spacing[3],
    paddingHorizontal: spacing[4],
    alignItems: 'center',
  },
  calloutText: {
    gap: spacing[1] / 2,
    alignItems: 'center',
  },
  calloutCentered: {
    textAlign: 'center',
  },
  calloutActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
