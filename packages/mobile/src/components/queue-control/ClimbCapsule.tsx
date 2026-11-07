// The toolbar's center element: a floating pill showing the current climb's name
// with the grade colorized on the right — the same treatment as the climb list
// rows. Tap opens the PlayDrawer. The pill's background adapts to the UI variant
// (Liquid Glass / Material / fallback) via AccessoryBarSurface; the tap-to-open
// behaviour is shared with the native accessory via useAccessoryClimbTap.

import { useMemo, type ReactNode } from 'react';
import { View, StyleSheet, type ColorValue } from 'react-native';
import { DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import type { Climb } from '@boardsesh/queue';
import { TOOLBAR_CAPSULE_HEIGHT, TOOLBAR_CAPSULE_MAX_WIDTH, glassSize } from '../../theme/layout';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { Text } from '../Text';
import { MarqueeText } from '../MarqueeText';
import { DraftChip } from '../DraftChip';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { AccessoryBarSurface } from './AccessoryBarSurface';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { AccessoryPlayLink } from './AccessoryPlayLink';
import { LargeContentViewer } from '../LargeContentViewer';
import { largeContentTitle } from './accessory-large-content-title';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { BoardControlIndicator } from './BoardControlIndicator';
import { PickBulbSlot } from './PickPutOnBoardBulb';
import { usePickBulb } from './use-pick-bulb';
import { lastPickClimb } from '../../lib/last-pick-store';

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  formattedGrade: string | null;
  gradeColor: string;
  showThumbnail: boolean;
  boardConfig: BoardConfig | null;
};

function ClimbLabel({ climb, labelColor, formattedGrade, gradeColor, showThumbnail, boardConfig }: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {showThumbnail ? <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} /> : null}
      {/* The head climb's name scrolls when it overflows (Reduce-Motion-gated) so a
          long name reads in full; the grade stays pinned to the right. */}
      <MarqueeText
        active
        variant="subheadline"
        color={labelColor}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.name}
        textStyle={styles.nameText}
      >
        {climb.name}
      </MarqueeText>
      {/* A draft is missing from the Climbs list; the bar says why (#5954). The
          row's `gap` spaces it, and the name beside it absorbs the truncation. */}
      {climb.is_draft === true ? (
        <DraftChip maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE} testID="capsule-climb-draft" />
      ) : null}
      {formattedGrade ? (
        <Text
          variant="headline"
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[styles.gradeText, { color: gradeColor }]}
        >
          {formattedGrade}
        </Text>
      ) : null}
    </View>
  );
}

type ClimbCapsuleProps = {
  height?: number;
  /** Action floated inside the capsule on the right, outside the swipe target (e.g. the tick). */
  endAction?: ReactNode;
  endActionSize?: number;
};

export function ClimbCapsule({ height = TOOLBAR_CAPSULE_HEIGHT, endAction, endActionSize = 0 }: ClimbCapsuleProps) {
  const { systemColors } = useTheme();
  const { boardConfig } = useDrawerHost();
  const { resolveGrade } = useDisplayGrade();
  const { openPlay, preparePlay, currentItem, pick } = useAccessoryClimbTap();
  // Connection state drives the leading control + the "you have control" glow.
  // Read from the single source so the bar can't disagree with the drawer bulb.
  const { inAppBoardConnection, bluetooth } = useBoardConnectionState();

  // The climber's last pick (its mirror flip drawn) or the queue's current
  // (owner decision A). Never the wall's lit climb: that lives in the top "On
  // the wall" strip.
  const currentClimb = useMemo(() => (pick ? lastPickClimb(pick) : (currentItem?.climb ?? null)), [pick, currentItem]);
  // Board art needs the active board config; matches the iOS 26 native accessory.
  const showThumbnail = boardConfig != null;
  // The last pick's bulb (owner decision A): lit, unlit, or none for a climb
  // this wall can't light. Null while the bar shows the queue's current climb.
  const pickBulb = usePickBulb(pick);
  // Show the connect control once a board is bound (the BLE context exists),
  // and not for a pick no board here can light.
  const hasBoardControl = bluetooth != null && pickBulb?.kind !== 'none';
  // Only "you are driving the wall" lights the bar up.
  const connected = inAppBoardConnection === 'connectedByMe';

  // Boardsesh grade (label + colour) when the toggle is on and a trusted one
  // exists, else the legacy Aurora grade — the same treatment as the list rows.
  const grades = useMemo(() => {
    const resolved = currentClimb ? resolveGrade(currentClimb, boardConfig?.boardName) : null;
    return {
      current: resolved?.label ?? null,
      currentColor: resolved?.color ?? DEFAULT_GRADE_COLOR,
    };
  }, [currentClimb, resolveGrade, boardConfig?.boardName]);

  if (!currentClimb) return null;

  const capsuleRadius = height / 2;
  // Reserve room on the right so the name/grade never slide under the inline tick.
  const endActionReservedWidth = endAction ? endActionSize + spacing[2] : 0;
  const labelRight = spacing[4] + endActionReservedWidth;
  // Reserve room on the LEFT for the board control, symmetric to the tick, so the
  // climb name never slides under it.
  const leadingReservedWidth = hasBoardControl ? glassSize.inline + spacing[2] : 0;
  const labelLeft = spacing[4] + leadingReservedWidth;

  return (
    <AccessoryBarSurface
      height={height}
      borderRadius={capsuleRadius}
      emphasis={connected ? 'connected' : 'none'}
      style={[styles.capsule, styles.capsuleCap]}
    >
      <AccessoryPlayLink
        testID={`mini-player-current-${currentClimb.uuid}`}
        style={[styles.tapArea, { height, borderRadius: capsuleRadius }]}
        accessibilityLabel={currentClimb.name}
        onOpen={openPlay}
        onPrepare={preparePlay}
      >
        <LargeContentViewer
          style={[styles.labelSlot, { left: labelLeft, right: labelRight }]}
          title={largeContentTitle(currentClimb.name, grades.current)}
          onActivate={openPlay}
        >
          <ClimbLabel
            climb={currentClimb}
            labelColor={systemColors.label}
            formattedGrade={grades.current}
            gradeColor={grades.currentColor}
            showThumbnail={showThumbnail}
            boardConfig={boardConfig}
          />
        </LargeContentViewer>
      </AccessoryPlayLink>
      {/* Leading board control — outside the tap target so it never opens the
          drawer. Sits over the bar's left edge, symmetric to the trailing tick. */}
      {hasBoardControl ? (
        <View style={[styles.leadingActionSlot, { height }]}>
          {pick && pickBulb ? (
            // The last pick: unlit, the bulb puts it on the board (owner decision A).
            <PickBulbSlot
              pick={pick}
              bulb={pickBulb}
              size={glassSize.inline}
              enableLongPress
              litBulb={<BoardControlIndicator size={glassSize.inline} enableLongPress />}
            />
          ) : (
            <BoardControlIndicator size={glassSize.inline} enableLongPress />
          )}
        </View>
      ) : null}
      {endAction ? <View style={[styles.endActionSlot, { width: endActionSize, height }]}>{endAction}</View> : null}
    </AccessoryBarSurface>
  );
}

const styles = StyleSheet.create({
  capsule: {
    flex: 1,
  },
  // Centered-pill cap.
  capsuleCap: {
    maxWidth: TOOLBAR_CAPSULE_MAX_WIDTH,
  },
  tapArea: {
    flex: 1,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  labelSlot: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    justifyContent: 'center',
  },
  endActionSlot: {
    position: 'absolute',
    top: 0,
    right: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadingActionSlot: {
    position: 'absolute',
    top: 0,
    left: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  gradeText: {
    // Colorized like the list rows; right-aligned with a reserved min width
    // (tabular digits) so the grade column stays put as you swipe between climbs.
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'right',
  },
  name: {
    flex: 1,
    minWidth: 0,
  },
  nameText: {
    fontWeight: '600',
  },
});
