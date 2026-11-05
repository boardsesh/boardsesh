// "You have the board": the Climbs header's status capsule while this climber
// holds the board (Liquid Glass only). It takes the slot the "On the wall"
// capsule uses: when the wall shows your own queue head it is that climb's skin,
// and when the wall lights a different climb the "On the wall" capsule takes the
// slot instead (`resolveClimbsHeaderCapsule`). The tab-bar accessory platter says
// the same thing with a mark on its thumbnail; this is the words for it, at the
// top of the list where a collapsed platter has no room for the bulb.
//
// With a current climb it reads like the "On the wall" capsule: the climb's name
// over its grade and sends (#7281). No face: it would be your own, and the name
// needs the room. Without a climb it falls back to the bulb and "You have the board".
//
// A lit climb carries the wall button's hold-colour frost, with amber as the
// fallback before measurement or when holds are unavailable. With no climb,
// a held LED board uses just the frost base and grain. A board with no lights
// keeps the brand tone and "You have the wall".
// A tap lets go, like the lightbulbs' short press: it disconnects, or releases a
// wall with no lights. While this phone drives the wall it stops driving and
// keeps the link instead, as every bulb does (owner, 2026-11-03;
// `useBulbDriveTap`), and its hint says so. A long-press opens the Bluetooth
// controls sheet (Re-light / Turn off / Disconnect) while this device holds the
// radio link.
// While it draws the climb on the wall it carries the wall capsule's Hide: a left
// swipe and the screen-reader action, no × (#7281). A tap here lets go of the
// board, so a touch that panned is never a tap or a long press.

import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import { useQueueData } from '../../providers/queue/queue-contexts';
import { useTheme } from '../../providers/theme-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { hapticMedium } from '../../lib/haptics';
import { useSettledHeaderValue } from '../chrome/use-settled-header-value';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { useBulbDriveTap } from './bar-bulb-tap';
import { phoneDrivesTheWall } from './bulb-drive-cue';
import { showsWallHoldLook } from './board-control-indicator-state';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { HeaderCapsuleClimbLabel, HeaderStatusCapsule, useHeaderCapsuleCompact } from './HeaderStatusCapsule';
import { useWallCapsuleDismiss } from './use-wall-capsule-dismiss';
import { useClimbStatsDetail } from './use-climb-byline';
import { WallCapsuleSwipe } from './WallCapsuleSwipe';
import { useClimbWallGlow } from './use-climb-wall-glow';
import { useWallGlowLayer, wallGlowBlendFor, type WallGlowLayer } from '../play-drawer/use-wall-glow';
import { wallGlowSurfaces } from '../../theme/colors';
import { WallGlow } from '../play-drawer/WallGlow';

const CAPSULE_GLYPH_SIZE = 16;

/** Hide the climb on the wall for this lighting, as the "On the wall" capsule does. */
export type HeldCapsuleDismiss = {
  occurrenceKey: string;
  onDismiss: (occurrenceKey: string) => void;
};

type BoardHeldCapsuleProps = {
  /** The board has no LED light kit: a pin and the brand tone, never amber. */
  ledless: boolean;
  /** Set while the capsule draws the climb on the wall; absent for a bare hold. */
  dismiss?: HeldCapsuleDismiss;
};

const DISMISS_ACTION = 'dismiss';
// The swipe's key while there is nothing to hide; its pan is off then.
const NO_OCCURRENCE = 'board-held';

function BoardHeldCapsuleImpl({ ledless: ledlessBoard, dismiss }: BoardHeldCapsuleProps) {
  const { t } = useTranslation('settings');
  const { t: tSession } = useTranslation('session');
  const { systemColors, brandColors, colorScheme } = useTheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  // A held LED board with no climb still gets the frost base and grain. Empty
  // blobs deliberately supply no invented hold colours and need no measurement.
  const emptyGlow = useMemo<WallGlowLayer>(
    () => ({
      key: `held-header-empty-${scheme}`,
      blobs: [],
      fade: 0,
      surface: wallGlowSurfaces[scheme],
      ...wallGlowBlendFor(scheme),
      readableZone: 'full',
    }),
    [scheme],
  );
  const { open: openControls } = useBleControlSheet();
  const compact = useHeaderCapsuleCompact();
  const reduceMotion = useReducedMotion();
  const swipe = useWallCapsuleDismiss({
    occurrenceKey: dismiss?.occurrenceKey ?? NO_OCCURRENCE,
    onDismiss: dismiss?.onDismiss,
    reduceMotion,
  });
  const { consumePanned } = swipe;
  // Your queue head, the climb the board shows while you hold it. Read here, not
  // in ClimbTopChrome, so a queue change re-renders only this capsule; settled
  // like the header's other inputs so the title view holds still under the
  // player's dismiss (#6619). Null shows the plain "You have the board".
  const { currentClimbQueueItem } = useQueueData();
  const climb = useSettledHeaderValue(currentClimbQueueItem?.climb ?? null);
  // The bulbs' press path: connectedByMe → disconnect, a held wall with no
  // lights → release. Long-press opens the controls only while this device
  // holds the radio link (a virtual hold has no controller to write to).
  const {
    onPress: lightbulbPress,
    onLongPress: openControlsIfLocal,
    localConnected,
    pressAction,
    inAppBoardConnection,
  } = useLightbulbControl({
    surface: 'header_pill',
    onOpenControls: openControls,
  });
  // The pin and "You have the wall" only without a live link: this phone's link
  // to a wall-device board's LEDs reads as any LED board's.
  const ledless = showsWallHoldLook({ ledless: ledlessBoard, localConnected });
  // Any drive this phone runs: the tap stops it and keeps the link.
  const { driving, takeTap } = useBulbDriveTap({
    drivesTheWall: phoneDrivesTheWall({ inAppBoardConnection, localConnected, ledless }),
    linked: localConnected,
    control: 'header_pill',
  });
  // The capsule mounts on a settled "you hold the board", so for a moment after
  // the player closes it can outlive the hold. A tap then must not connect or
  // take the wall: it only ever lets go (or stops a drive).
  // A swipe that sprang back must not end as the tap that lets go.
  const onPress = useCallback(() => {
    if (consumePanned()) return;
    if (takeTap()) return;
    if (pressAction !== 'disconnect' && pressAction !== 'releaseWall') return;
    lightbulbPress();
  }, [consumePanned, takeTap, pressAction, lightbulbPress]);

  const plainGlow = !ledless && localConnected ? emptyGlow : null;
  const toneColor = ledless ? brandColors.primary : brandColors.warning;
  const statusLabel = t(ledless ? 'ble.barControl.wallHeldLabel' : 'ble.barControl.youHaveBoard');

  const handleLongPress = useCallback(() => {
    if (!localConnected || consumePanned()) return;
    hapticMedium();
    openControlsIfLocal();
  }, [localConnected, consumePanned, openControlsIfLocal]);
  const handleDismiss = dismiss ? swipe.dismiss : undefined;
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
      else if (event.nativeEvent.actionName === DISMISS_ACTION) handleDismiss?.();
    },
    [handleLongPress, handleDismiss],
  );
  const hideLabel = tSession('mobile.boardPresence.stripDismiss');
  const actionList = [
    ...(localConnected ? [{ name: 'longpress', label: t('ble.holdForControls') }] : []),
    ...(handleDismiss ? [{ name: DISMISS_ACTION, label: hideLabel }] : []),
  ];
  const accessibilityActions = actionList.length > 0 ? actionList : undefined;
  // The label stays the words on the pill (Voice Control says them); while
  // driving the hint is the frosted button's own.
  const accessibilityHint = driving
    ? tSession('playView.wallControl.stopDrivingHint')
    : t(ledless ? 'ble.barControl.wallHeldHint' : 'ble.barControl.connectedHint');

  const capsule = climb ? (
    <HeldClimbCapsule
      climb={climb}
      ledless={ledless}
      toneColor={toneColor}
      onPress={onPress}
      onLongPress={handleLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      accessibilityHint={accessibilityHint}
    />
  ) : (
    <HeaderStatusCapsule
      tintColor={toneColor}
      entryKey={ledless ? 'wall-held' : 'board-held'}
      onPress={onPress}
      onLongPress={handleLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      accessibilityLabel={statusLabel}
      accessibilityHint={accessibilityHint}
      compact={compact}
      background={
        plainGlow
          ? {
              content: <WallGlow layer={plainGlow} width={0} />,
              color: plainGlow.surface.base,
              borderColor: plainGlow.surface.border,
            }
          : undefined
      }
      testID="board-held-capsule"
    >
      {compact ? null : (
        <Icon
          maxFontSizeMultiplier={1}
          name={ledless ? 'pin.fill' : 'lightbulb.fill'}
          size={CAPSULE_GLYPH_SIZE}
          color={toneColor}
        />
      )}
      {/* At an accessibility text size the viewer takes the hold and cancels the
          capsule's own long press, then activates when the finger lifts. A hold
          means "board controls" here, so the lift opens them; it never lets go. */}
      <LargeContentViewer title={statusLabel} onActivate={handleLongPress} style={styles.labelViewer}>
        <Text
          variant="caption1"
          color={plainGlow?.surface.label ?? systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[
            styles.label,
            plainGlow && (plainGlow.surface.frost ? styles.glowShadowDark : styles.glowShadowLight),
          ]}
        >
          {statusLabel}
        </Text>
      </LargeContentViewer>
    </HeaderStatusCapsule>
  );

  // Always wrapped (the pan is off with nothing to hide), so Hide arriving or
  // leaving with the presence feed never remounts the capsule and its frost.
  return <WallCapsuleSwipe swipe={swipe}>{capsule}</WallCapsuleSwipe>;
}

type HeldClimbCapsuleProps = {
  climb: Climb;
  ledless: boolean;
  toneColor: string;
  onPress: () => void;
  onLongPress: () => void;
  accessibilityActions: { name: string; label: string }[] | undefined;
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
  accessibilityHint: string;
};

/**
 * Your climb's name over its grade and sends, no face (#7281). Split out so the
 * glow and the stats read only run with a climb; exported for the
 * header-capsules story.
 */
export function HeldClimbCapsule({
  climb,
  ledless,
  toneColor,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
  accessibilityHint,
}: HeldClimbCapsuleProps) {
  const { t } = useTranslation('settings');
  const { boardConfig } = useDrawerHost();
  const { resolveGrade } = useDisplayGrade();
  const { colorScheme } = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const glow = useClimbWallGlow(climb, boardConfig, !ledless);
  const glowLayer = useWallGlowLayer(glow, size.width, size.height, colorScheme === 'dark' ? 'dark' : 'light', 'full');
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
  }, []);

  const grade = resolveGrade(climb, boardConfig?.boardName).label;
  const sendsDetail = useClimbStatsDetail(climb, boardConfig);
  const accessibilityLabel = t(ledless ? 'ble.barControl.wallHeldWithClimb' : 'ble.barControl.youHaveBoardWithClimb', {
    name: climb.name,
    grade: grade ?? '',
  });

  return (
    <HeaderStatusCapsule
      tintColor={toneColor}
      entryKey={climb.uuid}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      compact
      onLayout={handleLayout}
      background={
        glowLayer
          ? {
              content: <WallGlow layer={glowLayer} width={size.width} />,
              color: glowLayer.surface.base,
              borderColor: glowLayer.surface.border,
            }
          : undefined
      }
      testID="board-held-capsule"
    >
      <HeaderCapsuleClimbLabel
        avatar={null}
        name={climb.name}
        byline={{ grade: grade || null, detail: sendsDetail }}
        textColor={glowLayer?.surface.label}
        textStyle={glowLayer ? (glowLayer.surface.frost ? styles.glowShadowDark : styles.glowShadowLight) : undefined}
        compact
        largeContentTitle={accessibilityLabel}
        // The viewer takes the hold at accessibility sizes; its lift is the long
        // press (board controls), never the tap that lets go of the board.
        onActivate={onLongPress}
      />
    </HeaderStatusCapsule>
  );
}

export const BoardHeldCapsule = memo(BoardHeldCapsuleImpl);

const styles = StyleSheet.create({
  labelViewer: {
    // A flex:1 label has zero intrinsic width in a UIKit navigation title view.
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
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
});
