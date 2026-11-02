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
//   lit, timed   frost  [💡 You are driving the wall · 0:38 (me)]  the same, from Put on board (2.7):
//                       [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓.........................]  the frost shrinks to the bulb
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
//
// Swipe left to drive (#7113): where the model offers it (`swipeAction`) and
// the host hands `onSwipe` (the `wall-swipe-to-drive` flag), ‹‹ chevrons sit
// before the face, flat amber progress peeks in once (`useWallSwipePeek`), and
// dragging left wipes it in from the trailing edge (`useWallSwipe`,
// `WallSwipeWipe`). The frost appears only once the model confirms driving.
//
// Put on board's timed drive (2.7, Stop driving after) looks like any drive:
// the frost and You are driving the wall, plus a clock beside the label, and
// the frost shrinks toward the bulb as the time runs out, refilling with each
// climb that lights (`WallWindowClock.tsx`: the clock is a leaf that ticks on
// its own, the shrink runs on the UI thread). The swipe still works there and
// makes the drive open-ended: the clock goes and the frost stays full. The
// screen-reader value is the time left on a 10 s step, split from the label.

import { PressableSurface, type PressableSurfaceProps } from '../PressableSurface';
import { memo, useCallback, useMemo, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View, type ColorValue, type LayoutChangeEvent } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useScreenReaderEnabled } from '../../hooks/use-screen-reader-enabled';
import { useWallSwipePeek } from '../../lib/wall-swipe-hint';
import {
  LONG_PRESS_ACTION_NAME,
  namedAccessibilityActions,
  onNamedAccessibilityAction,
  type NamedAccessibilityAction,
} from '../../lib/named-accessibility-action';
import { wallGlowSurfaces, withAlpha } from '../../theme/colors';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { WALL_CONTROL_TONAL_ALPHA, type WallControlModel } from './wall-control';
import { formatWindowClock, useWallControlText, windowTimeValue } from './wall-control-text';
import { WallGlow } from './WallGlow';
import { wallControlUsesFrost } from './wall-control-frost';
import { WallSwipeWipe } from './WallSwipeWipe';
import { useWallGlowLayer, type WallGlowInput, type WallGlowLayer } from './use-wall-glow';
import { useWallSwipe } from './use-wall-swipe';
import { peekProgress } from './wall-swipe';
import type { DriveStartOutcome } from './use-wall-control';
import { useWindowSecondsLeft, WallWindowDigits, WallWindowFrost } from './WallWindowClock';

const ICON_SIZE = 20;
/** The holder's face. 24pt reads as a face inside a 44pt control. */
const AVATAR_SIZE = 24;
/** Both edges reserve the wider of the bulb and the face, so the label is centred either way. */
const EDGE_SLOT = Math.max(ICON_SIZE, AVATAR_SIZE);
/** German and French run long; shrink a little before the label truncates. */
const MIN_FONT_SCALE = 0.8;
/** The narrower workout button has less room; German still fits at 85%. */
const COMPACT_MIN_FONT_SCALE = 0.85;

/** The screen-reader action that starts driving the wall (#7113). */
export const DRIVE_ACTION_NAME = 'lightEveryClimb';
/** The swipe hint's chevrons: 10 pt glyphs, 2 pt apart, 4 pt before the face slot. */
const CHEVRON_SIZE = 10;
const CHEVRON_GAP = 2;
const CHEVRON_FACE_GAP = 4;
/**
 * Leading chevron first: the stronger one points the way. 70% and 40% of the
 * brand violet: the mocks' 25% vanished on the dark tonal pill (Marco).
 */
const CHEVRON_ALPHAS = [0.7, 0.4] as const;

/** A frozen frame of the swipe, for the stories: no gesture, no live peek. */
export type WallSwipePreview = {
  /** The flat swipe progress, 0 to 1 of the width. */
  progress?: number;
  /** The peek's frame: flat progress showing 28 pt in from the trailing edge. */
  peek?: boolean;
};

/**
 * The button's height: the inline control floor, 44pt on iOS and Material's
 * 48dp minimum touch target on Android. The second row's fixed height is built
 * from it (`ACTION_BAR_SECONDARY_ROW_HEIGHT`), and it is never taller than the
 * first row's 48pt buttons, so the workout's top row keeps its height.
 */
export const WALL_CONTROL_HEIGHT = Platform.OS === 'android' ? glassSize.inlinePrimary : glassSize.inline;

/**
 * Android's edge Back takes the wall button's swipe (#7113 PR 5). With gesture
 * navigation a horizontal drag that starts near either screen edge is the
 * system's Back, which closes the player. Measured on a Pixel 8 Pro: drags
 * starting 35 dp or more from the edge drive the wall; drags starting 28 dp or
 * less go Back. The full-width button ended 16 dp from the edge (the row's
 * padding), so its trailing ~12 dp sat inside that zone, and neither React
 * Native nor Gesture Handler can exclude the zone without native code.
 *
 * So on Android the full-width button takes this much more margin on BOTH
 * sides, 32 dp from each edge in all: the same on the left and the right, so
 * it stays centred in its row instead of looking like a layout bug. Only where
 * the button is the one thing drawn in a phone's second row (`spansRow`),
 * which is where it reaches the screen edge; the workout's compact one between
 * ⏮ and ⏭, the one between the bulb row's buttons, and the first-row one
 * beside a MiniPlayer (a tablet's pane) are not at the edge. iOS's edge swipe is the leading
 * edge's alone and the button's leftward drag starts away from it, so iOS is
 * unchanged. The height is untouched, so the second row's fixed height holds.
 */
export const ANDROID_EDGE_BACK_EXTRA_INSET = spacing[4];

/** The extra side margin the button takes, the same on each side (`ANDROID_EDGE_BACK_EXTRA_INSET`). */
export function wallControlEdgeInset(spansRow: boolean): number {
  return spansRow && Platform.OS === 'android' ? ANDROID_EDGE_BACK_EXTRA_INSET : 0;
}

type WallControlButtonProps = {
  model: WallControlModel;
  /** The workout's top-row button, between ⏮ and ⏭: tighter padding, a little more shrink. */
  compact?: boolean;
  /**
   * The button is the only thing in its row, so it reaches the screen's edges:
   * on Android it keeps clear of the edge Back zone (`ANDROID_EDGE_BACK_EXTRA_INSET`).
   */
  spansRow?: boolean;
  onPress: () => void;
  onLongPress: () => void;
  /**
   * Start driving the wall (#7113): what the swipe runs, and the screen-reader
   * action "Light every climb" while the model offers it (`swipeAction`).
   */
  onDrive?: () => void;
  /**
   * The swipe left to drive (#7113): returns what starting the drive did.
   * Omitted (the `wall-swipe-to-drive` flag off), there are no chevrons, no
   * peek and no gesture.
   */
  onSwipe?: () => DriveStartOutcome;
  /** A swipe let go short of the commit point. */
  onSwipeCancel?: () => void;
  /**
   * The climb's holds, for the frost (F1b) only while the model is driving.
   * Without it, or with no holds, driving uses the flat amber too.
   */
  glow?: WallGlowInput | null;
  /** The stories' frozen swipe frame. */
  swipePreview?: WallSwipePreview;
  /**
   * A picture of the button (the preview-first card's sample): no testIDs, so
   * tests and Maestro `id:` selectors only ever find the real one. Android's
   * UiAutomator still lists resource-ids under a hidden subtree.
   */
  sample?: boolean;
};

function WallControlButtonComponent({
  model,
  compact = false,
  spansRow = false,
  onPress,
  onLongPress,
  onDrive,
  onSwipe,
  onSwipeCancel,
  glow = null,
  swipePreview,
  sample = false,
}: WallControlButtonProps) {
  const { brandColors, colorScheme, systemColors } = useTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current.w === width && current.h === height ? current : { w: width, h: height }));
  }, []);
  const reduceMotion = useReduceMotion();
  // The swipe, where the model offers it and the host wires it (#7113).
  const swipeOffered = model.swipeAction === 'drive' && onSwipe != null;
  // A story's frozen frame, only where the swipe is offered (as the live one).
  const previewProgress =
    swipePreview === undefined || !swipeOffered
      ? null
      : swipePreview.peek
        ? peekProgress(size.w)
        : (swipePreview.progress ?? 0);
  // The peek (spec B3): at the first keep-lighting window in a session, and the
  // session's one replay on a third Put on board within 5 minutes.
  const screenReaderOn = useScreenReaderEnabled();
  const peekToken = useWallSwipePeek({
    offered: swipeOffered && swipePreview === undefined,
    windowLive: model.lightWindow,
    screenReaderOn,
  });
  const swipe = useWallSwipe({
    enabled: swipeOffered,
    driving: model.driving,
    drivePhase: model.drivePhase,
    onSwipe,
    onCancel: onSwipeCancel,
    peekToken,
    reduceMotion,
    width: size.w,
    preview: previewProgress,
  });
  // The swipe draws where it starts something: anywhere not driving, and on a
  // timed drive, which it makes open-ended.
  const swipeDrawn = !model.driving || model.lightWindow;
  // Flat progress mounts during a drag, peek or committed swipe awaiting drive.
  const wiping = swipeDrawn && (swipe.frostArmed || swipe.committed);
  // The canonical rule also excludes virtual walls and Set active.
  const frosted = wallControlUsesFrost(model);
  const glowShown = frosted ? glow : null;
  // The filled bulb tracks this phone's ownership separately from driving frost.
  const holdsBoard = model.holder === 'self';
  const fullGlow = useWallGlowLayer(glowShown, size.w, size.h, colorScheme === 'dark' ? 'dark' : 'light');
  const text = useWallControlText(model);
  const hold = model.longPress === 'sheet';
  const busy = model.pending || model.writing;
  // Clear of Android's edge Back, the same on both sides so it stays centred.
  const edgeInset = wallControlEdgeInset(spansRow);
  const label = swipe.releaseArmed && swipeDrawn ? text.releaseLabel : text.label;
  const showChevrons = swipeOffered && !model.driving;

  const { consumePanned, noteLongPress } = swipe;
  const handlePress = useCallback(() => {
    if (model.pending || consumePanned()) return;
    onPress();
  }, [model.pending, onPress, consumePanned]);
  // A hold that fires first wins the touch: a drag after it does nothing.
  const handleLongPress = useCallback(() => {
    if (consumePanned()) return;
    noteLongPress();
    onLongPress();
  }, [onLongPress, consumePanned, noteLongPress]);
  // A screen reader can't swipe the button, so the swipe is a named action too
  // (WCAG 2.5.1), beside the hold's board controls.
  const drive = model.swipeAction === 'drive' ? onDrive : undefined;
  const namedActions = useMemo(() => {
    const actions: NamedAccessibilityAction[] = [];
    if (hold) actions.push({ name: LONG_PRESS_ACTION_NAME, label: text.longPressActionLabel, run: onLongPress });
    if (drive) actions.push({ name: DRIVE_ACTION_NAME, label: text.driveActionLabel, run: drive });
    return actions.length > 0 ? actions : null;
  }, [hold, text.longPressActionLabel, onLongPress, drive, text.driveActionLabel]);
  const accessibilityActions = useMemo(
    () => (namedActions ? namedAccessibilityActions(namedActions) : undefined),
    [namedActions],
  );
  const onAccessibilityAction = useMemo(
    () => (namedActions ? onNamedAccessibilityAction(namedActions) : undefined),
    [namedActions],
  );

  // Nothing to offer (no board selected, no climb): the row keeps its height.
  if (model.state === null) {
    return <View style={styles.placeholder} testID={sample ? undefined : 'play-drawer-wall-control-empty'} />;
  }

  // Driving without hold geometry uses the flat live colour.
  const lit = model.driving;
  // Put on board's timed drive: its frost shrinks as the time runs out.
  const timed = model.lightWindow;
  // Amber with white text in light; the dark scheme's amber is pale, so dark text.
  const litForeground = colorScheme === 'dark' ? brandColors.onAccent : brandColors.onPrimary;
  // On the wall per presence, with no link (QA #147): an amber outline on the
  // sheet. Connecting alone does not claim driving or add a face.
  const onWallUnlinked = model.state === 'on_wall_unlinked';
  // The glow (F1b) brings its own surface: white over the dark pill, dark over
  // the light one. The tonal label takes the deeper violet in light, so it
  // keeps 4.6:1 on the wash (`wall-control-button-contrast`).
  const tonalForeground = brandColors.primaryStrong;
  const restForeground = fullGlow
    ? fullGlow.surface.label
    : lit
      ? litForeground
      : onWallUnlinked
        ? systemColors.label
        : tonalForeground;
  // Under a shrinking frost the pill shows through, so the label must read on
  // both: with holds, the frost's own pill (its label is made for it); with
  // none, the flat amber shrinks over the pill whose label is the amber's ink
  // (white in light, dark in dark), so the label reads on either.
  const flatTrack = colorScheme === 'dark' ? wallGlowSurfaces.light : wallGlowSurfaces.dark;
  const background = fullGlow
    ? fullGlow.surface.base
    : model.driving
      ? timed
        ? flatTrack.base
        : brandColors.live
      : onWallUnlinked
        ? 'transparent'
        : withAlpha(brandColors.primaryFill, WALL_CONTROL_TONAL_ALPHA);
  const face = model.holderFace;

  /** The bulb, the label, the chevrons and the face slot, in one set of colours. */
  const row = (rowColors: {
    foreground: ColorValue;
    bulb: ColorValue;
    shadow: WallGlowLayer | null;
    chevrons: (alpha: number) => ColorValue;
    /** The resting row carries the testIDs and the large-content action; the wipe's copy only draws. */
    resting: boolean;
  }) => (
    <>
      <View style={[styles.edge, styles.edgeLeading]}>
        {busy ? (
          <ActivityIndicator size="small" color={rowColors.foreground} />
        ) : (
          // Lit up while this climber has the board: the bulb is the board.
          <Icon
            name={holdsBoard ? 'lightbulb.fill' : 'lightbulb'}
            size={ICON_SIZE}
            color={rowColors.bulb}
            maxFontSizeMultiplier={1}
          />
        )}
      </View>
      <WallLabelViewer
        testID={
          rowColors.resting && !sample
            ? `wall-control-${model.state}-${model.holder ?? 'none'}-${model.driving ? 'driving' : 'idle'}`
            : undefined
        }
        title={label}
        lightWindow={model.lightWindow}
        onActivate={model.pending || !rowColors.resting ? undefined : handlePress}
        style={styles.labelViewer}
      >
        <View style={styles.labelRow}>
          <Text
            variant="subheadline"
            color={rowColors.foreground}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={compact ? COMPACT_MIN_FONT_SCALE : MIN_FONT_SCALE}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[
              styles.label,
              rowColors.shadow && (rowColors.shadow.surface.frost ? styles.glowShadowDark : styles.glowShadowLight),
            ]}
          >
            {label}
          </Text>
          {/* The clock is its own run, so the words shrink and cut first and the digits never do. */}
          {model.lightWindow ? <WallWindowDigits color={rowColors.foreground} /> : null}
        </View>
      </WallLabelViewer>
      {showChevrons ? (
        <View
          style={[styles.chevrons, { marginEnd: CHEVRON_FACE_GAP - (compact ? spacing[1] : spacing[2]) }]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={rowColors.resting && !sample ? 'play-drawer-wall-control-swipe-hint' : undefined}
        >
          {CHEVRON_ALPHAS.map((alpha) => (
            <Icon
              key={alpha}
              name="chevron.left"
              size={CHEVRON_SIZE}
              color={rowColors.chevrons(alpha)}
              maxFontSizeMultiplier={1}
            />
          ))}
        </View>
      ) : null}
      <View
        style={[styles.edge, styles.edgeTrailing]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID={face && rowColors.resting && !sample ? 'play-drawer-wall-control-holder' : undefined}
      >
        {face ? (
          <BoardDriverAvatar size={AVATAR_SIZE} userId={null} uri={face.avatarUrl} name={face.name} status="none" />
        ) : null}
      </View>
    </>
  );
  const button = (
    <WallControlSurface
      lightWindow={model.lightWindow}
      testID={sample ? undefined : 'play-drawer-wall-control'}
      onPress={handlePress}
      onLongPress={hold ? handleLongPress : undefined}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityRole="button"
      accessibilityLabel={text.accessibilityLabel}
      accessibilityHint={text.accessibilityHint}
      accessibilityState={{ selected: model.selected, busy }}
      // The sheet's label colour is a platform colour on iOS, where no ripple draws anyway.
      android_ripple={androidRipple(typeof restForeground === 'string' ? restForeground : brandColors.primary)}
      onLayout={handleLayout}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        edgeInset > 0 && { marginLeft: edgeInset, marginRight: edgeInset },
        { backgroundColor: background },
        // A plain hairline with the busy fill: Marco wanted the border simple.
        fullGlow && [styles.glowBorder, { borderColor: fullGlow.surface.border }],
        onWallUnlinked && [styles.onWallBorder, { borderColor: brandColors.live }],
        pressed && styles.pressed,
      ]}
    >
      {/* The frost, whole in a drive, shrinking in Put on board's timed one. Always
          wrapped, so a timed drive turning open-ended never remounts the glow. */}
      {fullGlow ? (
        <WallWindowFrost width={size.w} reduceMotion={reduceMotion} timed={timed}>
          <WallGlow layer={fullGlow} width={size.w} />
        </WallWindowFrost>
      ) : lit && timed ? (
        <WallWindowFrost width={size.w} reduceMotion={reduceMotion} timed>
          <View style={[styles.flatFrost, { backgroundColor: brandColors.live }]} />
        </WallWindowFrost>
      ) : null}
      {row({
        foreground: restForeground,
        // Amber, except on the plain amber fill (a lit climb with no holds to
        // frost), where it would vanish: there it takes the label colour.
        bulb: (holdsBoard || onWallUnlinked) && !(lit && !fullGlow) ? brandColors.live : restForeground,
        shadow: fullGlow,
        chevrons: (alpha) => withAlpha(fullGlow ? fullGlow.surface.label : tonalForeground, alpha),
        resting: true,
      })}
      {wiping && size.w > 0 ? (
        <WallSwipeWipe
          progress={swipe.progress}
          opacity={swipe.opacity}
          width={size.w}
          fill={brandColors.live}
          rowStyle={[styles.wipeRow, compact && styles.compact]}
        >
          {row({
            foreground: litForeground,
            bulb: litForeground,
            shadow: null,
            chevrons: () => litForeground,
            resting: false,
          })}
        </WallSwipeWipe>
      ) : null}
    </WallControlSurface>
  );
  // The pan is enabled only where the swipe is offered (`useWallSwipe`); always
  // wrapped, so the button never remounts as the offer comes and goes. `pan-y`
  // keeps a browser's vertical scroll (Expo web), as the climb rows do.
  return (
    <GestureDetector gesture={swipe.gesture} touchAction="pan-y">
      {button}
    </GestureDetector>
  );
}

export const WallControlButton = memo(WallControlButtonComponent);

type WallLabelViewerProps = ComponentProps<typeof LargeContentViewer> & {
  /** Put on board's timed drive is on: the viewer shows the time left too. */
  lightWindow: boolean;
};

/**
 * The label's Large Content Viewer (spec B3). The label and its clock are both
 * capped, and in a timed drive the time left is the news, so the viewer shows
 * "You are driving the wall · 0:38". A leaf of its own, so the clock's 1 Hz
 * tick re-renders only this; the row it wraps is the parent's element, which
 * React keeps as it is.
 */
function WallLabelViewer({ lightWindow, title, ...viewer }: WallLabelViewerProps) {
  const clock = useWindowSecondsLeft(1);
  const shownTitle = lightWindow && clock ? `${title} · ${formatWindowClock(clock.secondsLeft * 1000)}` : title;
  return <LargeContentViewer {...viewer} title={shownTitle} />;
}

type WallControlSurfaceProps = PressableSurfaceProps & {
  /** Put on board's timed drive is on: the time left is the value. */
  lightWindow: boolean;
};

/**
 * The button's pressable, which carries the timed drive's time left as its
 * screen-reader value ("You are driving the wall", then "Stops in 30 seconds").
 * A leaf of its own because the value steps every 10 s: only this re-renders
 * for it. The row, the glow and the swipe are the parent's elements, handed in
 * as children, so React keeps them as they are.
 */
function WallControlSurface({ lightWindow, ...pressable }: WallControlSurfaceProps) {
  const { t } = useTranslation('session');
  const windowClock = useWindowSecondsLeft(10);
  const windowValue = lightWindow && windowClock ? windowTimeValue(windowClock.secondsLeft * 1000, t) : null;
  const accessibilityValue = useMemo(() => (windowValue ? { text: windowValue } : undefined), [windowValue]);
  return <PressableSurface {...pressable} accessibilityValue={accessibilityValue} />;
}

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
  // The flat amber standing in for the frost in a timed drive with no holds.
  flatFrost: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
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
  // The label and, in a timed drive, its clock: centred together, the words shrinking first.
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
    maxWidth: '100%',
  },
  // The wipe's copy of the row, laid over the flat progress fill.
  wipeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[3],
    gap: spacing[2],
  },
  chevrons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CHEVRON_GAP,
  },
  label: {
    fontWeight: '600',
    textAlign: 'center',
    flexShrink: 1,
  },
});
