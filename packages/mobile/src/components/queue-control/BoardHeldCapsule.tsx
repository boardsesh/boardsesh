import { BoardHeldCapsuleView, HeldClimbCapsuleView, type HeldClimbCapsuleProps } from './BoardHeldCapsuleView';
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

import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { type AccessibilityActionEvent } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { hapticMedium } from '../../lib/haptics';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useQueueData } from '../../providers/queue/queue-contexts';
import { useTheme } from '../../providers/theme-provider';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { useSettledHeaderValue } from '../chrome/use-settled-header-value';
import { useBulbDriveTap } from './bar-bulb-tap';
import { showsWallHoldLook } from './board-control-indicator-state';
import { phoneDrivesTheWall } from './bulb-drive-cue';
import { useClimbStatsDetail } from './use-climb-byline';
import { useClimbWallGlow } from './use-climb-wall-glow';
import { useWallCapsuleDismiss } from './use-wall-capsule-dismiss';
import { WallCapsuleSwipe } from './WallCapsuleSwipe';

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
  const { brandColors } = useTheme();
  const { open: openControls } = useBleControlSheet();
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

  const toneColor = ledless ? brandColors.primary : brandColors.warning;

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
    <BoardHeldCapsuleView
      ledless={ledless}
      localConnected={localConnected}
      onPress={onPress}
      onLongPress={handleLongPress}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={handleAccessibilityAction}
      accessibilityHint={accessibilityHint}
    />
  );

  // Always wrapped (the pan is off with nothing to hide), so Hide arriving or
  // leaving with the presence feed never remounts the capsule and its frost.
  return <WallCapsuleSwipe swipe={swipe}>{capsule}</WallCapsuleSwipe>;
}

/**
 * Your climb's name over its grade and sends, no face (#7281). Split out so the
 * glow and the stats read only run with a climb; exported for the
 * header-capsules story.
 */
export function HeldClimbCapsule(props: HeldClimbCapsuleProps) {
  const { boardConfig } = useDrawerHost();
  const { resolveGrade } = useDisplayGrade();
  const glow = useClimbWallGlow(props.climb, boardConfig, !props.ledless);
  const grade = resolveGrade(props.climb, boardConfig?.boardName).label;
  const sendsDetail = useClimbStatsDetail(props.climb, boardConfig);
  return <HeldClimbCapsuleView {...props} grade={grade} sendsDetail={sendsDetail} glow={glow} />;
}

export const BoardHeldCapsule = memo(BoardHeldCapsuleImpl);
