import { PressableSurface } from '../PressableSurface';
// The drawer header's leading slot: the back chip, while a browse latch or a
// pinned preview is up. A back glyph, the word "Back", and the face of whoever
// lit the wall when going back lands on their climb. Tap it to go back.
//
// There used to be an On the wall chip and a Live chip here too. They went in
// #7000: the wall button under the board says whether the climb on screen is
// lit, and a second place saying it could disagree.
//
// Two platform-native skins behind ONE stateful body (`selectByVariant` inside)
// rather than a variant component swap, so a live variant flip can't reset the
// keyed content (see theme/variants/README.md). Nothing here writes, so a stray
// tap costs nothing. State-change narration lives in the host
// (`use-wall-state-announcer`): the chip unmounts on the commonest latch exit,
// so an effect in here would die with the transition it needs to speak.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, androidRipple } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize, WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useWallDriver } from './use-wall-driver';

/** The one state the header chip renders — `null` means the host omits it. */
export type WallStatePillState = 'browsing';

const PILL_HEIGHT = glassSize.mini;
const BROWSING_GLYPH_SIZE = 14;
/** Beside the back glyph the face drops to 20pt, so the chip stays the pill's 32pt tall. */
const BROWSING_AVATAR_SIZE = 20;
/** The widest the words may get; "My pick" and "On the wall" fit, and German's "An der Wand" too, at the default size. */
const BACK_WORD_MAX_WIDTH = 96;

/**
 * Two shapes that never mix, so the wrong chip can't be built.
 *
 * The chip the climber taps to go back, which must carry an `onPress` —
 * without one it renders a dead 44pt target that looks tappable.
 *
 * Or a RESERVE-ONLY copy: invisible, untappable, hidden from assistive tech,
 * there purely to hold the slot's space. The swipe peek header uses it so its
 * header measures the same flank width as the one it slides in behind — the
 * climb name and its attribute glyphs then hold their exact position through a
 * swipe instead of stepping when the two headers disagree about whether a chip
 * exists. It renders the REAL chip rather than a fixed-width spacer because the
 * width is the translated word's ("Back" / "Volver" / "Zurück" all differ) and
 * the face comes and goes — only the real thing measures right. An `onPress`
 * on this shape would promise a tap nothing answers, so the union forbids it.
 */
type BackChipProps = {
  /**
   * Where the back chip goes. `wall` lands on the lit climb, so the chip shows
   * the face of whoever lit it; `current` lands on the climber's own climb while
   * the wall shows something else (or nothing).
   */
  backTarget?: 'wall' | 'current' | null;
  /** The climb back goes to, named to a screen reader ("Back to my pick: The Eyes"). */
  targetName?: string | null;
  /**
   * A browse latch is up, so swipes really don't move the wall and the hint may
   * say so. A preview with lighting on has no such promise.
   */
  latched?: boolean;
};

type WallStatePillProps = BackChipProps &
  (
    | { state: WallStatePillState; onPress: () => void; reserveOnly?: false }
    | { state: WallStatePillState; onPress?: never; reserveOnly: true }
  );

type WallStatePillAccessibility = { label: string; hint?: string };

/** What the chip says to a screen reader: where back goes, the climb by name, and (latched) that the wall stays put. */
function describeWallStatePill(
  { backTarget, latched, targetName }: Required<BackChipProps>,
  t: TFunction<'session'>,
): WallStatePillAccessibility {
  const name = targetName?.trim() || null;
  let label: string;
  if (backTarget === 'wall') {
    label = name ? t('playView.wallState.backToWallNamed', { name }) : t('playView.wallState.backToWall');
  } else {
    label = name ? t('playView.wallState.backToMyPickNamed', { name }) : t('playView.wallState.backToCurrent');
  }
  return { label, hint: latched ? t('playView.wallState.browsingHint') : undefined };
}

/**
 * The chip's screen-reader label and hint, outside the chip. The play drawer's
 * fixed header stand-in names its wall-chip action with these, so the action
 * says exactly what the chip would. Null when there is no chip.
 */
export function useWallStatePillAccessibility({
  state,
  backTarget = null,
  latched = true,
  targetName = null,
}: BackChipProps & { state: WallStatePillState | null }): WallStatePillAccessibility | null {
  const { t } = useTranslation('session');
  return state === null ? null : describeWallStatePill({ backTarget, latched, targetName }, t);
}

function WallStatePillImpl({
  state,
  onPress,
  reserveOnly = false,
  backTarget = null,
  latched = true,
  targetName = null,
}: WallStatePillProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, m3, m3SurfaceContainers } = useTheme();
  const reduceMotion = useReducedMotion();
  // Read unconditionally (hook rules); a chip back to the wall renders the
  // face, and `useBoardDriver` degrades to null outside a board-presence provider.
  const { driver, name: driverName } = useWallDriver();
  const { label: accessibilityLabel, hint: accessibilityHint } = describeWallStatePill(
    { backTarget, latched, targetName },
    t,
  );
  const showFace = driver !== null && backTarget === 'wall';

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Liquid Glass earns its edge from a hairline border, Material from a tonal
  // surface container (depth by tone, flat at M3 level 0).
  const containerStyle = isMaterial
    ? { backgroundColor: m3SurfaceContainers.high, borderColor: systemColors.separator }
    : {
        backgroundColor: systemColors.secondaryBackground,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: systemColors.separator,
      };
  const labelColor = isMaterial ? m3.onSurface : systemColors.label;
  // Borderless so the ripple reads on the capsule rather than squaring off the
  // taller touch box around it, in the M3 on-surface state layer.
  const rippleColor = m3.onSurface;

  return (
    <PressableSurface
      onPress={reserveOnly ? undefined : onPress}
      accessibilityRole={reserveOnly ? undefined : 'button'}
      accessibilityLabel={reserveOnly ? undefined : accessibilityLabel}
      accessibilityHint={reserveOnly ? undefined : accessibilityHint}
      accessibilityElementsHidden={reserveOnly}
      importantForAccessibility={reserveOnly ? 'no-hide-descendants' : 'auto'}
      android_ripple={reserveOnly ? undefined : androidRipple(rippleColor, true)}
      // Material answers a press with the ripple above; Liquid Glass has no state
      // layer, so it takes the drawer action bar's opacity + scale idiom.
      style={({ pressed }) => [
        styles.touchTarget,
        reserveOnly && styles.touchTargetReserved,
        pressed && !reserveOnly && !isMaterial && styles.touchTargetPressed,
      ]}
    >
      <Animated.View
        // Keyed so a chip that gains or loses its face re-enters rather than
        // cross-mutating styles.
        key={`${state}-${showFace ? 'face' : 'word'}`}
        entering={reduceMotion || reserveOnly ? undefined : FadeIn.duration(180)}
        style={[styles.pill, showFace ? styles.pillWithFace : styles.pillWordOnly, containerStyle]}
      >
        <Icon name="undo" size={BROWSING_GLYPH_SIZE} color={labelColor} />
        {/* The word the glyph alone left unsaid. Its label already says where
            back goes, so screen readers skip it. */}
        <Text
          variant="caption1"
          color={labelColor}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={styles.word}
        >
          {/* Where back goes, in words (QA #147): your own climb, or the wall's. */}
          {backTarget === 'wall' ? t('playView.wallState.backOnWall') : t('playView.wallState.backMyPick')}
        </Text>
        {showFace ? (
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <BoardDriverAvatar
              size={BROWSING_AVATAR_SIZE}
              userId={null}
              uri={driver.avatarUrl ?? null}
              name={driverName}
              status="none"
            />
          </View>
        ) : null}
      </Animated.View>
    </PressableSurface>
  );
}

export const WallStatePill = memo(WallStatePillImpl);

const styles = StyleSheet.create({
  // The pressable carries the 44pt touch floor — the same value DrawerHeader
  // reserves for the slot — while the capsule inside stays 32pt. `hitSlop` can't
  // do this job here: the touch area never extends past the parent's bounds, and
  // every ancestor of this chip (the header's measured leading flank) sizes to
  // its content, so slop on a 32pt chip is inert on both platforms.
  touchTarget: {
    flexShrink: 1,
    height: WALL_STATE_PILL_TOUCH_HEIGHT,
    justifyContent: 'center',
    // The capsule hugs its content; without this it would stretch to whatever
    // width the header's flank hands the (taller) touch box.
    alignItems: 'flex-start',
  },
  touchTargetPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
  // Holds the slot's width and height without painting anything and without
  // answering a touch — one style is the whole of "inert". `pointerEvents` rides
  // the style rather than the Pressable prop, which React Native deprecated in
  // 0.64.
  touchTargetReserved: {
    opacity: 0,
    pointerEvents: 'none',
  },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: PILL_HEIGHT,
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    gap: spacing[1],
    minWidth: WALL_STATE_PILL_TOUCH_HEIGHT,
  },
  // The face brings its own optical padding on the right.
  pillWithFace: {
    paddingLeft: spacing[2],
    paddingRight: spacing[1],
  },
  pillWordOnly: {
    paddingHorizontal: spacing[3],
  },
  // DrawerHeader gives both flanks the wider of the two widths, so every point
  // here comes off the climb name twice. Capped: "Back" (~30 pt) fits, a long
  // translation truncates rather than squeezing the name further.
  word: {
    fontWeight: '600',
    flexShrink: 1,
    maxWidth: BACK_WORD_MAX_WIDTH,
  },
});
