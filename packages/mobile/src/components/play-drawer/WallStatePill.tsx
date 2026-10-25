import { PressableSurface } from '../PressableSurface';
// The drawer header's leading slot: one capsule that says what the WALL is
// doing, so the climber never has to guess whether looking at a climb moved it.
//
//   onWall   — the displayed climb is the one physically lit. The driver's face,
//              in the amber "lit" vocabulary WallStatusCapsule established.
//   live     — the next navigation drives the wall / the shared queue. A live dot
//              plus the word.
//   browsing — a browse latch is up: you're looking, the wall stays put. A back
//              glyph plus the face of whoever lit the wall: tap it to go back
//              to their climb. Neutral, like the other two: the loud thing on
//              screen is Put on the wall, the one control that changes anything.
//
// Two platform-native skins behind ONE stateful body (`selectByVariant` inside)
// rather than a variant component swap, so a live variant flip can't reset the
// keyed content (see theme/variants/README.md).
//
// On the wall and Live it is an INDICATOR: a tap opens the explainer callout,
// which is where the driver-profile tap lives. Browsing it is the way back, the
// same act as the callout's Back to live. Nothing here writes, so a stray tap
// costs nothing. State-change narration lives in the host
// (`use-wall-state-announcer`): the pill unmounts on the commonest latch exit,
// so an effect in here would die with the transition it needs to speak.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, androidRipple } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize, WALL_LIVE_DOT_SIZE, WALL_STATE_PILL_TOUCH_HEIGHT } from '../../theme/layout';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { Icon } from '../Icon';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useWallDriver } from './use-wall-driver';
import type { WallPillState } from './wall-state';

/** The states that actually render — `null` means the host omits the pill. */
export type WallStatePillState = Exclude<WallPillState, null>;

const PILL_HEIGHT = glassSize.mini;
/** 24pt reads as a face at the pill's 32pt height with 4pt of breathing room. */
const AVATAR_SIZE = 24;
const BROWSING_GLYPH_SIZE = 14;
/** Beside the back glyph the face drops to 20pt, so the chip stays the pill's 32pt tall. */
const BROWSING_AVATAR_SIZE = 20;

/**
 * Two shapes that never mix, so the wrong pill can't be built.
 *
 * The INDICATOR the climber taps to open the explainer, which must carry an
 * `onPress` — without one it renders a dead 44pt target that looks tappable.
 *
 * Or a RESERVE-ONLY copy: invisible, untappable, hidden from assistive tech,
 * there purely to hold the slot's space. The swipe peek header uses it so its
 * header measures the same flank width as the one it slides in behind — the
 * climb name and its attribute glyphs then hold their exact position through a
 * swipe instead of stepping when the two headers disagree about whether a pill
 * exists. It renders the REAL pill rather than a fixed-width spacer because the
 * width is the translated label's ("Live" / "En vivo" / "En direct" all differ)
 * and an avatar chip is narrower again — only the real thing measures right.
 * An `onPress` on this shape would promise a tap nothing answers, so the union
 * forbids it.
 */
type BackChipProps = {
  /**
   * Browsing only: where the back chip goes. `wall` lands on the lit climb, so
   * the chip shows the face of whoever lit it; `current` lands on the
   * climber's own climb while the wall shows something else (or nothing).
   */
  backTarget?: 'wall' | 'current' | null;
  /**
   * Browsing only: a browse latch is up, so swipes really don't move the wall
   * and the hint may say so. A preview with lighting on has no such promise.
   */
  latched?: boolean;
};

type WallStatePillProps = BackChipProps &
  (
    | { state: WallStatePillState; onPress: () => void; reserveOnly?: false }
    | { state: WallStatePillState; onPress?: never; reserveOnly: true }
  );

type WallStatePillAccessibility = { label: string; hint?: string };

/** What the pill says to a screen reader, given what the wall-driver hook read. */
function describeWallStatePill(
  state: WallStatePillState,
  {
    backTarget,
    latched,
    driverName,
    litAgo,
  }: Required<BackChipProps> & { driverName: string | null; litAgo: string | null },
  t: TFunction<'session'>,
): WallStatePillAccessibility {
  const driverLabel = driverName
    ? t('mobile.boardPresence.drivenByA11y', { name: driverName })
    : t('mobile.boardPresence.drivenByAnonA11y');

  // The words the pill deliberately doesn't print (a ~106pt "On the wall" chip
  // would permanently crush the climb name in DrawerHeader's mirrored flanks)
  // ride the label instead. Recency joins them here rather than as a corner
  // label: at 24pt that badge renders ~9pt text, below the type floor.
  const label =
    state === 'onWall'
      ? [t('playView.wallState.onWall'), driverLabel, litAgo].filter(Boolean).join('. ')
      : state === 'live'
        ? t('playView.wallState.live')
        : backTarget === 'wall'
          ? t('playView.wallState.backToWall')
          : t('playView.wallState.backToCurrent');

  const stateHint =
    state === 'onWall'
      ? t('playView.wallState.onWallHint')
      : state === 'live'
        ? t('playView.wallState.liveHint')
        : t('playView.wallState.browsingHint');
  // Browsing's tap is the way back, which its label already says; it only adds
  // "the wall stays where it is" while that's true. The other two open the
  // explainer, which the pill hint promises.
  const hint =
    state === 'browsing' ? (latched ? stateHint : undefined) : `${stateHint} ${t('playView.wallState.pillHint')}`;
  return { label, hint };
}

/**
 * The pill's screen-reader label and hint, outside the pill. The play drawer's
 * fixed header stand-in names its wall-pill action with these, so the action
 * says exactly what the pill would. Null when there is no pill.
 */
export function useWallStatePillAccessibility({
  state,
  backTarget = null,
  latched = true,
}: BackChipProps & { state: WallStatePillState | null }): WallStatePillAccessibility | null {
  const { t } = useTranslation('session');
  // Read unconditionally (hook rules); `useBoardDriver` degrades to null
  // outside a board-presence provider.
  const { name: driverName, litAgo } = useWallDriver();
  return state === null ? null : describeWallStatePill(state, { backTarget, latched, driverName, litAgo }, t);
}

function WallStatePillImpl({
  state,
  onPress,
  reserveOnly = false,
  backTarget = null,
  latched = true,
}: WallStatePillProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, brandColors, m3, m3SurfaceContainers } = useTheme();
  const reduceMotion = useReducedMotion();
  // Read unconditionally (hook rules); onWall and a back chip to the wall render
  // the face, and
  // `useBoardDriver` degrades to null outside a board-presence provider.
  const { driver, name: driverName, litAgo } = useWallDriver();
  const { label: accessibilityLabel, hint: accessibilityHint } = describeWallStatePill(
    state,
    { backTarget, latched, driverName, litAgo },
    t,
  );

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  // Liquid Glass earns its edge from a hairline border, Material from a tonal
  // surface container (depth by tone, flat at M3 level 0).
  const neutralSurface = isMaterial
    ? { backgroundColor: m3SurfaceContainers.high }
    : { backgroundColor: systemColors.secondaryBackground, borderWidth: StyleSheet.hairlineWidth };
  const labelColor = isMaterial ? m3.onSurface : systemColors.label;

  const containerStyle =
    state === 'onWall'
      ? { ...neutralSurface, borderColor: withAlpha(brandColors.live, 0.35) }
      : { ...neutralSurface, borderColor: systemColors.separator };

  // The "lit" carrier composited over the neutral surface: warm amber on Liquid
  // Glass, the M3 tertiary role on Material — the exact WallStatusCapsule
  // vocabulary, now on the dedicated `live` brand role.
  const tintColor = isMaterial ? withAlpha(m3.tertiary, 0.12) : withAlpha(brandColors.live, 0.14);
  // Borderless so the ripple reads on the capsule rather than squaring off the
  // taller touch box around it, in the M3 on-surface state layer. Android-only,
  // so the Material role is the right source even in the Liquid Glass branch.
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
        // Keyed so a state change re-enters rather than cross-mutating styles.
        // Removal is an instant cut: the host unmounts the slot in the same commit,
        // which Reanimated can't reliably intercept with an `exiting`.
        key={state}
        entering={reduceMotion || reserveOnly ? undefined : FadeIn.duration(180)}
        style={[
          styles.pill,
          state === 'onWall'
            ? styles.pillAvatar
            : state === 'browsing'
              ? driver && backTarget === 'wall'
                ? styles.pillBack
                : styles.pillBackGlyphOnly
              : styles.pillLabelled,
          containerStyle,
        ]}
      >
        {state === 'onWall' ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
        ) : null}
        {state === 'onWall' ? (
          // Inert + a11y-hidden so the pill reads as one node. `userId={null}`
          // only suppresses the avatar's own profile-link tap (a nested pressable
          // inside a button); the face still resolves from `uri`. The profile tap
          // lives in the callout's driver row.
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <BoardDriverAvatar
              size={AVATAR_SIZE}
              userId={null}
              uri={driver?.avatarUrl ?? null}
              name={driverName}
              status={litAgo ? 'none' : 'connected'}
            />
          </View>
        ) : state === 'live' ? (
          <>
            <View style={[styles.liveDot, { backgroundColor: brandColors.live }]} />
            <LargeContentViewer title={accessibilityLabel} onActivate={reserveOnly ? undefined : onPress}>
              <Text
                variant="caption1"
                color={labelColor}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.liveLabel}
              >
                {t('playView.wallState.live')}
              </Text>
            </LargeContentViewer>
          </>
        ) : (
          <>
            <Icon name="undo" size={BROWSING_GLYPH_SIZE} color={labelColor} />
            {driver && backTarget === 'wall' ? (
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
          </>
        )}
      </Animated.View>
    </PressableSurface>
  );
}

export const WallStatePill = memo(WallStatePillImpl);

const styles = StyleSheet.create({
  // The pressable carries the 44pt touch floor — the same value DrawerHeader
  // reserves for the slot — while the capsule inside stays 32pt. `hitSlop` can't
  // do this job here: the touch area never extends past the parent's bounds, and
  // every ancestor of this pill (the header's measured leading flank) sizes to
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
  },
  // The avatar brings its own optical padding; a labelled chip needs gutters.
  pillAvatar: {
    paddingHorizontal: spacing[1],
  },
  pillLabelled: {
    paddingHorizontal: spacing[3],
  },
  liveDot: {
    width: WALL_LIVE_DOT_SIZE,
    height: WALL_LIVE_DOT_SIZE,
    borderRadius: borderRadius.full,
  },
  liveLabel: {
    fontWeight: '600',
  },
  // The back glyph needs a gutter; the face beside it brings its own.
  pillBack: {
    paddingLeft: spacing[2],
    paddingRight: spacing[1],
  },
  // No face to show (nothing lit, or nobody we can name): the glyph alone,
  // held at the 44pt touch width so it is still an easy target.
  pillBackGlyphOnly: {
    minWidth: WALL_STATE_PILL_TOUCH_HEIGHT,
    justifyContent: 'center',
  },
});
