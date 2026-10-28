import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type ColorValue, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Text } from '../Text';
import { MarqueeText } from '../MarqueeText';
import { DraftChip } from '../DraftChip';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { AccessoryPlayLink } from './AccessoryPlayLink';
import { LargeContentViewer } from '../LargeContentViewer';
import { largeContentTitle } from './accessory-large-content-title';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { BoardControlIndicator } from './BoardControlIndicator';
import { useClimbByline } from './use-climb-byline';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { AccessoryConnectionBadge } from './AccessoryConnectionBadge';
import {
  getBoardConnectionBadgeVisual,
  getBoardConnectionLabel,
  type BoardConnectionBadgeVisual,
} from './board-control-indicator-state';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import {
  ACCESSORY_GROUP_GAP,
  ACCESSORY_LABEL_TRAILING_PADDING,
  ACCESSORY_LEADING_INSET,
  ACCESSORY_PLATTER_THUMBNAIL_SIZE,
  ACCESSORY_THUMBNAIL_GAP,
  ACCESSORY_TRAILING_INSET,
  isMiniPlayerButtonAvailable,
  miniPlayerCapacityWidth,
  miniPlayerPaneCoveredButtons,
  miniPlayerPaneMode,
  miniPlayerSlotCount,
  resolveMiniPlayerControls,
} from './mini-player-controls';
import { usePlayerButtonsPreference } from '../../lib/player-buttons-preference';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { resolvePlayerAngle } from '../play-drawer/player-angle';
import { usePanePlayerShowsPreview } from '../play-drawer/pane-preview-store';
import { useAuth } from '../../providers/auth-provider';
import { useSegments } from 'expo-router';
import { isPlayerRoute } from '../../lib/route-segments';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import { publishMeasuredMiniPlayerBar } from '../../lib/mini-player-measured-bar-store';
import { MiniPlayerLeadingButtons } from './MiniPlayerButtons';
import { useMiniPlayerButtons } from '../../lib/mini-player-buttons-preference';
import type { MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { useVerticalTabBar } from '../../hooks/use-vertical-tab-bar';
import { usePhoneSplitPaneTaken } from '../navigation/phone-split-pane-slot';
import { useQueueData, useQueueSessionId } from '../../providers/queue-provider';
import { useWorkoutRun } from '../../lib/workout-run-store';
import { findWorkoutRunStage, workoutOutcomeAvailable } from '../play-drawer/workout-outcome';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  queueItemUuid?: string;
  placement: AccessoryPlacement;
  testID?: string;
};

const TRAILING_CONTROL_SLOTS = ['lightbulb', 'log'] as const;

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  bylineColor: ColorValue;
  byline: string | null;
  thumbnailSize: number | null;
  boardConfig: BoardConfig | null;
  connectionBadge: BoardConnectionBadgeVisual | null;
};

/**
 * Thumbnail, then the name over a byline, like a song over its artist in Apple
 * Music's platter: "V4 · 7.7k sends", or the rating when nobody has sent it.
 */
function ClimbLabel({
  climb,
  labelColor,
  bylineColor,
  byline,
  thumbnailSize,
  boardConfig,
  connectionBadge,
}: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {thumbnailSize !== null ? (
        // The connection mark rides the artwork's corner, so it costs the name no
        // width in the 44pt collapsed platter.
        <View style={{ width: thumbnailSize, height: thumbnailSize }}>
          <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} size={thumbnailSize} />
          <AccessoryConnectionBadge visual={connectionBadge} />
        </View>
      ) : null}
      <View style={styles.titleBlock}>
        <View style={styles.titleLine}>
          {/* Scrolls a long name when it overflows (Reduce-Motion-gated). Falls
              back to tail-ellipsis when it fits or motion is off. */}
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
          {/* A draft is missing from the Climbs list; the bar says why (#5954).
              The name beside it absorbs the truncation. */}
          {climb.is_draft === true ? (
            <DraftChip maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE} testID="accessory-climb-draft" />
          ) : null}
        </View>
        {byline ? (
          <Text
            variant="footnote"
            color={bylineColor}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.bylineText}
          >
            {byline}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Whether ⏮ ⏭ can take a place on the bar. Not in a timed workout block, whose
 * stage moves the wall on its own beat (#6231): a tap there would skip a rep.
 */
function useTransportAvailable(): boolean {
  const { sessionId } = useQueueSessionId();
  const { currentClimbQueueItem } = useQueueData();
  const workoutRun = useWorkoutRun(sessionId);
  return !workoutOutcomeAvailable(findWorkoutRunStage(workoutRun, currentClimbQueueItem?.uuid ?? null));
}

/**
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: the current climb, the
 * climber's MiniPlayer buttons (#6940), then the lightbulb and the tick at the
 * trailing edge. How many controls fit is `miniPlayerSlotCount`; which ones is
 * `resolveMiniPlayerControls`. The collapsed platter has room for one control:
 * the lightbulb while the board is free (so connecting stays one tap away), the
 * tick once someone holds it. A mark on the thumbnail says who holds it, in both
 * placements. The
 * displayed climb is resolved once by {@link QueueBottomAccessory} and passed in,
 * so this component never re-gates (a second gate could blank the live platter for
 * a frame, which UIKit snapshotted as doubled text). Tap-to-open is shared with
 * the floating capsule via useAccessoryClimbTap. Its plain grade + board thumbnail
 * are tuned for the platter, so they intentionally differ from the floating
 * capsule's colorized grade.
 */
export function NativeAccessoryClimbRow({ climb, queueItemUuid, placement, testID }: NativeAccessoryClimbRowProps) {
  const { width: windowWidth } = useWindowDimensions();
  const { boardConfig, playDrawerPaneProps } = useDrawerHost();
  const { systemColors, brandColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const { openPlay, preparePlay } = useAccessoryClimbTap();
  const { t } = useTranslation('settings');
  const { bluetooth, inAppBoardConnection, ledless, holderDisplayName } = useBoardConnectionState();
  const { isTablet } = useDeviceLayout();
  const phoneSplit = usePhoneSplit();
  const verticalTabBar = useVerticalTabBar();
  const buttonsLayout = useMiniPlayerButtons();
  const transportAvailable = useTransportAvailable();
  const { isAuthenticated } = useAuth();
  // The angle the player's pill shows: the board it draws on, a foreign
  // climb's override included, and none on a fixed-angle board.
  const playerAngle = playDrawerPaneProps
    ? resolvePlayerAngle({
        isAngleAdjustable: playDrawerPaneProps.isAngleAdjustable,
        angle: playDrawerPaneProps.boardConfig.angle,
      })
    : null;
  const angleAdjustable = playerAngle !== null;
  // `isMiniPlayerButtonAvailable` drops Angle while the `/play` route is up.
  const playerRouteUp = isPlayerRoute(useSegments());
  const playerBoardName = playDrawerPaneProps?.boardConfig.boardName ?? null;
  const playerLayoutId = playDrawerPaneProps?.boardConfig.layoutId ?? null;
  const paneTaken = usePhoneSplitPaneTaken();
  const paneShowsPreview = usePanePlayerShowsPreview();
  const playerButtons = usePlayerButtonsPreference();
  const paneMode = miniPlayerPaneMode({
    phoneSplit,
    paneTaken,
    paneShowsPreview,
    controlsPosition: playerButtons.position,
  });
  const playerPaneShowsTransport = paneMode === 'carry';
  // The board the climb is drawn on, resolved the way the player resolves it, so
  // the heart and the share point at the same climb, board and angle.
  const climbBoard = useMemo(
    () => resolveClimbRenderBoard(climb, boardConfig)?.boardConfig ?? null,
    [climb, boardConfig],
  );

  const isInline = placement === 'inline';
  const rowHeight = isInline ? glassSize.inline : glassSize.standard;
  const thumbnailSize = boardConfig === null ? null : ACCESSORY_PLATTER_THUMBNAIL_SIZE;
  // The width UIKit gave the platter. A narrow open platter (iPhone Duo's outer
  // display beside its side rail, a 320pt Display Zoom iPhone) keeps one control,
  // like the collapsed one, so the name has room to read (miniPlayerSlotCount).
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const measuredWidth = Math.round(event.nativeEvent.layout.width);
    setRowWidth((previous) => (previous === measuredWidth ? previous : measuredWidth));
  }, []);
  const widthBesideName =
    ACCESSORY_LEADING_INSET +
    (thumbnailSize === null ? 0 : thumbnailSize + ACCESSORY_THUMBNAIL_GAP) +
    ACCESSORY_LABEL_TRAILING_PADDING +
    ACCESSORY_TRAILING_INSET;
  // iPad and the open Duo: as many as fit. An iPhone: three at most.
  const wide = isTablet || phoneSplit;
  // Between the climber's buttons and ⏮ ⏭, and before 💡 ✓, on a bar with room to spare.
  const groupGap = wide ? ACCESSORY_GROUP_GAP : 0;
  const capacityWidth = miniPlayerCapacityWidth({ windowWidth, rowWidth, wide, verticalTabBar });
  const slotCount = miniPlayerSlotCount({ placement, rowWidth: capacityWidth, widthBesideName, wide, groupGap });
  // Tell the View options preview what this device's open bar measures.
  useEffect(() => {
    if (placement === 'regular' && capacityWidth !== null) {
      publishMeasuredMiniPlayerBar({ rowWidth: capacityWidth, widthBesideName });
    }
  }, [placement, capacityWidth, widthBesideName]);
  // The platter shows a plain (non-colorized) grade; only the label swaps to the
  // Boardsesh grade when the toggle is on and a trusted one exists.
  const currentFormattedGrade = resolveGrade(climb, boardConfig?.boardName).label;
  const byline = useClimbByline(climb, boardConfig, currentFormattedGrade);

  const connectionBadge = getBoardConnectionBadgeVisual({
    boardConnection: inAppBoardConnection,
    connectedColor: brandColors.warning,
    peerColor: systemColors.secondaryLabel,
    ledless,
    wallHeldColor: brandColors.primary,
  });
  // One slot when collapsed or narrow: the bulb only while there is a board to
  // connect to and nobody holds it. With no board bound the bulb renders nothing,
  // so the tick keeps the slot.
  const collapsedSlotShowsBulb = bluetooth != null && inAppBoardConnection === 'disconnected';
  const isDraft = climb.is_draft === true;
  const climbBoardName = climbBoard?.boardName ?? null;
  const climbLayoutId = climbBoard?.layoutId ?? null;
  // The climb's own board, as the player decides whether it shows ⇄.
  const supportsMirroring =
    climbBoardName !== null && climbLayoutId !== null ? boardSupportsMirroring(climbBoardName, climbLayoutId) : false;
  const isAvailable = useCallback(
    (buttonId: MiniPlayerButtonId) =>
      isMiniPlayerButtonAvailable(buttonId, {
        transport: transportAvailable,
        mirror: supportsMirroring,
        signedIn: isAuthenticated,
        isDraft,
        angleAdjustable,
        playerRouteUp,
      }),
    [transportAvailable, supportsMirroring, isAuthenticated, isDraft, angleAdjustable, playerRouteUp],
  );
  const paneCoveredButtons = useMemo(
    () =>
      paneMode === 'stepAside'
        ? []
        : paneMode === 'carry'
          ? miniPlayerPaneCoveredButtons({
              buttons: playerButtons.buttons,
              previousNext: playerButtons.previousNext,
              supportsMirroring,
              hasShare: !isDraft,
              angleAvailable: angleAdjustable,
            })
          : undefined,
    [paneMode, playerButtons, supportsMirroring, isDraft, angleAdjustable],
  );
  const controls = useMemo(
    () =>
      resolveMiniPlayerControls({
        slotCount,
        layout: buttonsLayout,
        isAvailable,
        singleSlotShowsBulb: collapsedSlotShowsBulb,
        playerPaneShowsTransport,
        buttonIds: paneCoveredButtons,
      }),
    [slotCount, buttonsLayout, isAvailable, collapsedSlotShowsBulb, playerPaneShowsTransport, paneCoveredButtons],
  );
  // A visible bulb already speaks the state; without it, only the mark shows
  // it, so the climb link says it.
  const connectionValue =
    !controls.trailing.includes('lightbulb') && inAppBoardConnection !== 'disconnected'
      ? getBoardConnectionLabel(t, { boardConnection: inAppBoardConnection, ledless, holderDisplayName })
      : undefined;

  // UIKit can omit the central zoom-source subtree from its accessory AX tree.
  // CPP metadata belongs to this existing visible row; ordinary captures and
  // normal use leave each control's accessibility unchanged.
  return (
    <View
      // Both placements fill the frame UIKit gives them (react-native-screens sizes
      // the accessory root natively). A width worked out from the screen overshot
      // the real platter: open, by ~10pt, cramming the tick into the edge; collapsed,
      // where the bar also holds the selected and prominent tabs, by far more.
      style={[styles.row, { height: rowHeight }]}
      onLayout={handleRowLayout}
      testID={testID}
      accessible={testID ? true : undefined}
      accessibilityLabel={testID ? climb.name : undefined}
    >
      <AccessoryPlayLink
        style={styles.tapClip}
        accessibilityLabel={climb.name}
        accessibilityValue={connectionValue}
        onOpen={openPlay}
        onPrepare={preparePlay}
        zoomSourceRetained
      >
        <LargeContentViewer
          style={styles.labelSlot}
          title={largeContentTitle(climb.name, currentFormattedGrade)}
          onActivate={openPlay}
        >
          <ClimbLabel
            climb={climb}
            labelColor={systemColors.label}
            bylineColor={systemColors.secondaryLabel}
            byline={byline}
            thumbnailSize={thumbnailSize}
            boardConfig={boardConfig}
            connectionBadge={connectionBadge}
          />
        </LargeContentViewer>
      </AccessoryPlayLink>
      {/* The controls sit beside the climb gesture, never inside it, so their
          44pt tap targets are never stolen by the row's tap. Long-press on the
          bulb opens the controls sheet, as on the other lightbulbs now that a
          short press disconnects. The row stays mounted as controls appear and
          disappear: UIKit snapshots the platter between placements. */}
      {controls.leading.length > 0 ? (
        <MiniPlayerLeadingButtons
          queueItemUuid={queueItemUuid}
          buttonIds={controls.leading}
          climb={climb}
          climbBoard={climbBoard}
          angle={playerAngle}
          angleClimbUuid={
            climbBoardName === playerBoardName && climbLayoutId === playerLayoutId ? climb.uuid : undefined
          }
          bluetoothConnected={bluetooth?.isConnected ?? false}
          slotWidth={glassSize.inline}
          rowHeight={rowHeight}
          groupGap={groupGap}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={[
          styles.trailingSlot,
          { width: controls.trailing.length * glassSize.inline, height: rowHeight },
          controls.trailing.length > 0 && controls.leading.length > 0 ? { marginStart: groupGap } : null,
        ]}
      >
        {/* UIKit also resizes the hidden regular row while the bar is inline.
            Keep both native slot frames fixed inside one pair so expansion moves
            them together. Empty slots mount no button, handler or accessibility
            element. A lone bulb shifts the pair one slot to stay at the edge.
            The pair and its slots must not flatten into independent views. */}
        <View
          pointerEvents="box-none"
          collapsable={false}
          accessible={false}
          style={[
            styles.trailingPair,
            {
              width: TRAILING_CONTROL_SLOTS.length * glassSize.inline,
              height: rowHeight,
              right: controls.trailing.length === 1 && controls.trailing[0] === 'lightbulb' ? -glassSize.inline : 0,
            },
          ]}
        >
          {TRAILING_CONTROL_SLOTS.map((slot) => (
            <View
              key={`trailing-${slot}`}
              pointerEvents="box-none"
              collapsable={false}
              accessible={false}
              style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}
            >
              {controls.trailing.includes(slot) ? (
                slot === 'lightbulb' ? (
                  <BoardControlIndicator
                    size={glassSize.inline}
                    iconSize={22}
                    enableLongPress
                    solidGlyphs
                    placement={placement}
                  />
                ) : (
                  <LogAscentToolbarButton
                    queueItemUuid={queueItemUuid}
                    climb={climb}
                    size={glassSize.inline}
                    iconSize={24}
                    placement={placement}
                  />
                )
              ) : null}
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingStart: ACCESSORY_LEADING_INSET,
    paddingEnd: ACCESSORY_TRAILING_INSET,
  },
  tapClip: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  labelSlot: {
    justifyContent: 'center',
    height: '100%',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: ACCESSORY_THUMBNAIL_GAP,
    paddingEnd: ACCESSORY_LABEL_TRAILING_PADDING,
  },
  titleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
  },
  name: {
    flex: 1,
    minWidth: 0,
  },
  nameText: {
    fontWeight: '500',
  },
  bylineText: {
    fontVariant: ['tabular-nums'],
  },
  controlSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  trailingSlot: {
    flexShrink: 0,
  },
  trailingPair: {
    position: 'absolute',
    top: 0,
    flexDirection: 'row',
  },
});
