import { useMemo } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDifferentiateWithoutColor } from '../../hooks/use-differentiate-without-color';
import {
  LONG_PRESS_ACTION_NAME,
  namedAccessibilityActions,
  onNamedAccessibilityAction,
} from '../../lib/named-accessibility-action';
import { glassSize } from '../../theme/layout';
import type { PaneWallControl } from '../play-drawer/pane-wall-control-store';
import { useWallControlText } from '../play-drawer/wall-control-text';
import { WallWindowRing } from '../play-drawer/WallWindowRing';
import { drivingBulbColors, getPaneWallControlVisual } from './board-control-indicator-state';
import { bulbHaloFor, resolvePaneBulbDriveCue } from './bulb-drive-cue';

type PaneWallControlBulbProps = {
  control: PaneWallControl;
  size?: number;
  iconSize?: number;
  /** Filled glyphs, like the platter's other controls (see `BoardControlIndicator`). */
  solidGlyphs?: boolean;
};

/**
 * The MiniPlayer's bulb standing in for the player beside it (#7000, the tablet
 * rule, with the bulb chosen). It draws the player's own board control model and runs the
 * player's own tap and hold, so its face and taps match the player's, and the
 * events fire once with `control: 'mini_bar'`. During Put on board's timed
 * drive it carries the bar's cue (`BulbDriveCue`): the amber bulb ringed by
 * an amber arc that drains, the Live Activity's ring. An open-ended drive keeps
 * the amber disc. Its label is already the button's "You are driving the
 * wall", so no value: a live number would re-render the bar on every step.
 *
 * Its tap is the wall button's (`tapAction`), as on every bulb (owner,
 * 2026-11-03): during any drive it stops driving and keeps the link, and its
 * hint says so.
 */
export function PaneWallControlBulb({
  control,
  size = glassSize.inline,
  iconSize = 22,
  solidGlyphs = false,
}: PaneWallControlBulbProps) {
  const { model, press, longPress } = control;
  const { systemColors, brandColors, colorScheme } = useTheme();
  const differentiateWithoutColor = useDifferentiateWithoutColor();
  const text = useWallControlText(model);
  const driveCue = resolvePaneBulbDriveCue(model);
  const hold = model.longPress === 'sheet';
  const accessibilityActions = useMemo(
    () => (hold ? namedAccessibilityActions(LONG_PRESS_ACTION_NAME, text.longPressActionLabel) : undefined),
    [hold, text.longPressActionLabel],
  );
  const onAccessibilityAction = useMemo(
    () => (hold ? onNamedAccessibilityAction(LONG_PRESS_ACTION_NAME, longPress) : undefined),
    [hold, longPress],
  );
  const visual = getPaneWallControlVisual({
    look: model.look,
    holder: model.holder,
    state: model.state,
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    disconnectedColor: systemColors.secondaryLabel,
    wallHeldColor: brandColors.primary,
    solidGlyphs: solidGlyphs && differentiateWithoutColor !== 'on',
    // The disc is for an open-ended drive; a timed one is ringed instead.
    driving: driveCue === 'disc' ? drivingBulbColors(brandColors, colorScheme) : null,
  });
  const haloColor = bulbHaloFor(driveCue, visual.haloColor);
  if (model.state === null) return null;
  return (
    <PressableSurface
      testID="mini-player-pane-wall-control"
      onPress={model.pending ? undefined : press}
      onLongPress={hold ? longPress : undefined}
      accessibilityRole="button"
      accessibilityLabel={text.accessibilityLabel}
      accessibilityHint={text.accessibilityHint}
      accessibilityState={{ selected: model.selected, busy: model.pending || model.writing }}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      hitSlop={8}
      style={({ pressed }) => [
        styles.container,
        { width: size, height: size, borderRadius: size / 2 },
        haloColor ? { backgroundColor: haloColor, shadowColor: visual.iconColor as string } : null,
        haloColor ? styles.lit : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Icon maxFontSizeMultiplier={1} name={visual.iconName} size={iconSize} color={visual.iconColor} />
      {driveCue === 'drain' ? <WallWindowRing size={size} /> : null}
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // iOS-only elevation, as on the indicator: Android draws this round shadow as a hexagon.
  lit: {
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: Platform.OS === 'ios' ? 2 : 0,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
