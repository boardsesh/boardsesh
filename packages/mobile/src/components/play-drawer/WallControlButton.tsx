// The player's wall button (#7000): the second row, full width, the whole
// answer to "is this climb on the wall, how do I get it there, and whose board
// is it". It took the place of the first row's bulb, the header's On the wall
// chip, the "Lit on the wall" text and Put on the wall.
//
//   connect      tonal  [💡        Put on board             ]  tap connects, then lights it
//   put_on_wall  tonal  [💡        Put on board         (me)]  tap puts the preview up
//                       [💡        Put on board        (Sam)]  …on a crewmate's board
//   dark         tonal  [💡        Put on board         (me)]  tap re-lights the climb
//   lit          tonal  [💡      Disconnect board       (me)]  tap disconnects
//   lit, driving frost  [💡  You are driving the wall   (me)]  tap stops driving (#7113)
//   crew         tonal  [💡        Put on board        (Sam)]  tap relays to their phone
//
// The label says what a press does (#7113, Marco); the bulb's fill shows the
// connection and the face whose board it is.
//
// The bulb sits at the leading edge in every state, and whoever holds the board
// (this phone's climber, or a crewmate) at the trailing edge, at the same
// inset, so the label stays centred whether or not there is a face. Holding
// the button opens the board sheet (Re-light, Turn off all lights, Disconnect)
// while this phone holds the link. Only Disconnect board disconnects on a tap.
//
// It draws a `WallControlModel` (`resolveWallControl`) and nothing else: no
// presence or profile reads of its own, so the face can't outlive the link.
// The tap and the hold go to `useWallControl`, which does the haptics and the
// events. `compact` is the narrower button in a workout's top row, between
// ⏮ and ⏭ (#7000).

import { PressableSurface } from '../PressableSurface';
import { memo, useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useTheme } from '../../providers/theme-provider';
import {
  LONG_PRESS_ACTION_NAME,
  namedAccessibilityActions,
  onNamedAccessibilityAction,
} from '../../lib/named-accessibility-action';
import { withAlpha } from '../../theme/colors';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { WALL_CONTROL_TONAL_ALPHA, type WallControlModel } from './wall-control';
import { useWallControlText } from './wall-control-text';
import { WallGlow } from './WallGlow';
import { useWallGlowLayer, type WallGlowInput } from './use-wall-glow';

const ICON_SIZE = 20;
/** The holder's face. 24pt reads as a face inside a 44pt control. */
const AVATAR_SIZE = 24;
/** Both edges reserve the wider of the bulb and the face, so the label is centred either way. */
const EDGE_SLOT = Math.max(ICON_SIZE, AVATAR_SIZE);
/** German and French run long; shrink a little before the label truncates. */
const MIN_FONT_SCALE = 0.8;
/** The narrower workout button has less room; German still fits at 85%. */
const COMPACT_MIN_FONT_SCALE = 0.85;

/**
 * The button's height: the inline control floor, 44pt on iOS and Material's
 * 48dp minimum touch target on Android. The second row's fixed height is built
 * from it (`ACTION_BAR_SECONDARY_ROW_HEIGHT`), and it is never taller than the
 * first row's 48pt buttons, so the workout's top row keeps its height.
 */
export const WALL_CONTROL_HEIGHT = Platform.OS === 'android' ? glassSize.inlinePrimary : glassSize.inline;

type WallControlButtonProps = {
  model: WallControlModel;
  /** The workout's top-row button, between ⏮ and ⏭: tighter padding, a little more shrink. */
  compact?: boolean;
  onPress: () => void;
  onLongPress: () => void;
  /**
   * The climb's lit holds, for the lit look (F1b): handed only while the
   * climb on screen is lit on this phone's board or a crewmate's. Without it,
   * or with no holds, the lit button is the flat amber.
   */
  glow?: WallGlowInput | null;
};

function WallControlButtonComponent({
  model,
  compact = false,
  onPress,
  onLongPress,
  glow = null,
}: WallControlButtonProps) {
  const { brandColors, colorScheme, systemColors } = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current.w === width && current.h === height ? current : { w: width, h: height }));
  }, []);
  // The coloured lit look (the frost, or the amber fill) only while this
  // climber is driving the board: the model's rule, not the view's (#7017).
  const glowShown = model.driving ? glow : null;
  // Filled amber whenever this phone holds the board, in any state; the frost
  // (the glow) stays for the lit states only (Marco's QA).
  const holdsBoard = model.holder === 'self';
  const glowLayer = useWallGlowLayer(glowShown, size.w, size.h, colorScheme === 'dark' ? 'dark' : 'light');
  const text = useWallControlText(model);
  const hold = model.longPress === 'sheet';
  const busy = model.pending || model.writing;

  const handlePress = useCallback(() => {
    if (model.pending) return;
    onPress();
  }, [model.pending, onPress]);
  const longPressActions = useMemo(
    () => (hold ? namedAccessibilityActions(LONG_PRESS_ACTION_NAME, text.longPressActionLabel) : undefined),
    [hold, text.longPressActionLabel],
  );
  const onLongPressAction = useMemo(
    () => (hold ? onNamedAccessibilityAction(LONG_PRESS_ACTION_NAME, onLongPress) : undefined),
    [hold, onLongPress],
  );

  // Nothing to offer (no board selected, no climb): the row keeps its height.
  if (model.state === null) {
    return <View style={styles.placeholder} testID="play-drawer-wall-control-empty" />;
  }

  // In a crew the holder's lit climb (or held wall with no lights) keeps its
  // label, filled bulb and face on the plain tonal look: their swipes browse,
  // so they aren't driving it.
  const lit = model.driving;
  // Amber with white text in light; the dark scheme's amber is pale, so dark text.
  const litForeground = colorScheme === 'dark' ? brandColors.onAccent : brandColors.onPrimary;
  // On the wall per presence, with no link (QA #147): an amber outline on the
  // sheet, the label in the sheet's own label colour, so it reads as "up there"
  // without the fill and the frost that mean "you have the board".
  const onWallUnlinked = model.state === 'on_wall_unlinked';
  // The glow (F1b) brings its own surface: white over the dark pill, dark over the light one.
  const foreground = glowLayer
    ? glowLayer.surface.label
    : lit
      ? litForeground
      : onWallUnlinked
        ? systemColors.label
        : brandColors.primary;
  const background = glowLayer
    ? glowLayer.surface.base
    : lit
      ? brandColors.live
      : onWallUnlinked
        ? 'transparent'
        : withAlpha(brandColors.primaryFill, WALL_CONTROL_TONAL_ALPHA);
  const face = model.holderFace;

  return (
    <PressableSurface
      testID="play-drawer-wall-control"
      onPress={handlePress}
      onLongPress={hold ? onLongPress : undefined}
      accessibilityActions={longPressActions}
      onAccessibilityAction={onLongPressAction}
      accessibilityRole="button"
      accessibilityLabel={text.accessibilityLabel}
      accessibilityHint={text.accessibilityHint}
      accessibilityState={{ selected: model.selected, busy }}
      // The sheet's label colour is a platform colour on iOS, where no ripple draws anyway.
      android_ripple={androidRipple(typeof foreground === 'string' ? foreground : brandColors.primary)}
      onLayout={handleLayout}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        { backgroundColor: background },
        // A plain hairline with the busy fill: Marco wanted the border simple.
        glowLayer && [styles.glowBorder, { borderColor: glowLayer.surface.border }],
        onWallUnlinked && [styles.onWallBorder, { borderColor: brandColors.live }],
        model.autoDisconnectWarning && [styles.warning, { borderColor: brandColors.warning }],
        pressed && styles.pressed,
      ]}
    >
      {glowLayer ? <WallGlow layer={glowLayer} width={size.w} /> : null}
      <View style={[styles.edge, styles.edgeLeading]}>
        {busy ? (
          <ActivityIndicator size="small" color={foreground} />
        ) : (
          // Lit up while this climber has the board: the bulb is the board.
          <Icon
            name={holdsBoard ? 'lightbulb.fill' : 'lightbulb'}
            size={ICON_SIZE}
            // Amber, except on the plain amber fill (a lit climb with no holds to
            // frost), where it would vanish: there it takes the label colour.
            color={(holdsBoard || onWallUnlinked) && !(lit && !glowLayer) ? brandColors.live : foreground}
            maxFontSizeMultiplier={1}
          />
        )}
      </View>
      <LargeContentViewer
        title={text.label}
        onActivate={model.pending ? undefined : handlePress}
        style={styles.labelViewer}
      >
        <Text
          variant="subheadline"
          color={foreground}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={compact ? COMPACT_MIN_FONT_SCALE : MIN_FONT_SCALE}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[
            styles.label,
            glowLayer && (glowLayer.surface.frost ? styles.glowShadowDark : styles.glowShadowLight),
          ]}
        >
          {text.label}
        </Text>
      </LargeContentViewer>
      <View
        style={[styles.edge, styles.edgeTrailing]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={face ? 'play-drawer-wall-control-holder' : undefined}
      >
        {face ? (
          <BoardDriverAvatar size={AVATAR_SIZE} userId={null} uri={face.avatarUrl} name={face.name} status="none" />
        ) : null}
      </View>
    </PressableSurface>
  );
}

export const WallControlButton = memo(WallControlButtonComponent);

const styles = StyleSheet.create({
  // Fills the row, whose own padding matches the Logbook card's edges below it
  // (both sit spacing[4] in from the content's sides), so the two line up.
  button: {
    flex: 1,
    height: WALL_CONTROL_HEIGHT,
    borderRadius: WALL_CONTROL_HEIGHT / 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    gap: spacing[2],
    overflow: 'hidden',
  },
  // Between ⏮ and ⏭ the button has ~239pt on a 375pt phone: a little less
  // padding keeps the label's room.
  compact: {
    paddingHorizontal: spacing[2],
    gap: spacing[1],
  },
  edge: {
    width: EDGE_SLOT,
    height: EDGE_SLOT,
    justifyContent: 'center',
  },
  edgeLeading: {
    alignItems: 'flex-start',
  },
  edgeTrailing: {
    alignItems: 'flex-end',
  },
  glowBorder: {
    borderWidth: 1,
  },
  onWallBorder: {
    borderWidth: 1.5,
  },
  // The glow's label: a soft shadow under the fade (the mocks' "shadow + fade"):
  // 1 pt down, 1.5 pt blur, 60% black on the dark pill; a light lift on the pale one.
  glowShadowDark: {
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1.5,
  },
  glowShadowLight: {
    textShadowColor: 'rgba(255, 255, 255, 0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 1.5,
  },
  // The bulb's last-ten-seconds ring (BleLightbulbButton), drawn steady here.
  warning: {
    borderWidth: 2,
  },
  placeholder: {
    flex: 1,
    height: WALL_CONTROL_HEIGHT,
  },
  pressed: {
    opacity: 0.6,
    transform: [{ scale: 0.98 }],
  },
  labelViewer: { flex: 1, alignItems: 'center' },
  label: {
    fontWeight: '600',
    textAlign: 'center',
  },
});
