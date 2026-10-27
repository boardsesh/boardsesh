// "You have the board": the Climbs header's status capsule while this climber
// holds the board (Liquid Glass only). It takes the slot the "On the wall"
// capsule uses, which shows only when the wall lights a climb other than yours,
// so the two never compete. The tab-bar accessory platter says the same thing
// with a mark on its thumbnail; this is the words for it, at the top of the list
// where a collapsed platter has no room for the bulb.
//
// With a current climb it reads like the "On the wall" capsule and the platter:
// your face, then the climb's name over "V7 · 1.4k sends" (#6902). Without one
// it falls back to the bulb and "You have the board".
//
// Lit LEDs read amber. A board with no lights reads in the brand tone with a pin
// and "You have the wall": amber only ever means the LEDs are on.
// A tap lets go, like the lightbulbs' short press: it disconnects, or releases a
// wall with no lights. A long-press opens the Bluetooth controls sheet
// (Re-light / Turn off / Disconnect) while this device holds the radio link.

import { memo, useCallback } from 'react';
import { StyleSheet, type AccessibilityActionEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import { useQueueData } from '../../providers/queue/queue-contexts';
import { useTheme } from '../../providers/theme-provider';
import { useBleControlSheet } from '../../providers/ble-control-sheet-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { hapticMedium } from '../../lib/haptics';
import { useSettledHeaderValue } from '../chrome/use-settled-header-value';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Avatar } from '../Avatar';
import { HeaderCapsuleClimbLabel, HeaderStatusCapsule, useHeaderCapsuleCompact } from './HeaderStatusCapsule';
import { useClimbByline } from './use-climb-byline';

const CAPSULE_GLYPH_SIZE = 16;
// The same face size as the "On the wall" capsule. Fixed — does not scale with Dynamic Type.
const CAPSULE_AVATAR_SIZE = 24;

type BoardHeldCapsuleProps = {
  /** The board has no LED light kit: a pin and the brand tone, never amber. */
  ledless: boolean;
};

function BoardHeldCapsuleImpl({ ledless }: BoardHeldCapsuleProps) {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors } = useTheme();
  const { open: openControls } = useBleControlSheet();
  const compact = useHeaderCapsuleCompact();
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
  } = useLightbulbControl({
    surface: 'header_pill',
    onOpenControls: openControls,
  });
  // The capsule mounts on a settled "you hold the board", so for a moment after
  // the player closes it can outlive the hold. A tap then must not connect or
  // take the wall: it only ever lets go.
  const onPress = useCallback(() => {
    if (pressAction !== 'disconnect' && pressAction !== 'releaseWall') return;
    lightbulbPress();
  }, [pressAction, lightbulbPress]);

  const toneColor = ledless ? brandColors.primary : brandColors.warning;
  const statusLabel = t(ledless ? 'ble.barControl.wallHeldLabel' : 'ble.barControl.youHaveBoard');

  const handleLongPress = useCallback(() => {
    if (!localConnected) return;
    hapticMedium();
    openControlsIfLocal();
  }, [localConnected, openControlsIfLocal]);
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );
  const accessibilityActions = localConnected ? [{ name: 'longpress', label: t('ble.holdForControls') }] : undefined;
  const accessibilityHint = t(ledless ? 'ble.barControl.wallHeldHint' : 'ble.barControl.connectedHint');

  if (climb) {
    return (
      <HeldClimbCapsule
        climb={climb}
        ledless={ledless}
        toneColor={toneColor}
        compact={compact}
        onPress={onPress}
        onLongPress={handleLongPress}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={handleAccessibilityAction}
        accessibilityHint={accessibilityHint}
      />
    );
  }

  return (
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
          color={systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.label}
        >
          {statusLabel}
        </Text>
      </LargeContentViewer>
    </HeaderStatusCapsule>
  );
}

type HeldClimbCapsuleProps = {
  climb: Climb;
  ledless: boolean;
  toneColor: string;
  compact: boolean;
  onPress: () => void;
  onLongPress: () => void;
  accessibilityActions: { name: string; label: string }[] | undefined;
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
  accessibilityHint: string;
};

/**
 * Your face, then your climb over its byline. Split out so the stats read only
 * runs with a climb; exported for the header-capsules story.
 */
export function HeldClimbCapsule({
  climb,
  ledless,
  toneColor,
  compact,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
  accessibilityHint,
}: HeldClimbCapsuleProps) {
  const { t } = useTranslation('settings');
  const { boardConfig } = useDrawerHost();
  const { resolveGrade } = useDisplayGrade();
  const { data: profile } = useProfile();

  const grade = resolveGrade(climb, boardConfig?.boardName).label;
  const byline = useClimbByline(climb, boardConfig, grade);
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
      compact={compact}
      testID="board-held-capsule"
    >
      <HeaderCapsuleClimbLabel
        avatar={
          <Avatar
            uri={profile?.avatarUrl}
            name={profile?.displayName ?? profile?.email ?? null}
            size={CAPSULE_AVATAR_SIZE}
          />
        }
        name={climb.name}
        byline={byline}
        compact={compact}
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
});
