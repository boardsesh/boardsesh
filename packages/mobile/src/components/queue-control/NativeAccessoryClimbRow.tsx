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
  ACCESSORY_LABEL_TRAILING_PADDING,
  ACCESSORY_THUMBNAIL_GAP,
  TALL_PLATTER_MIN_HEIGHT,
  accessoryPlatterGeometry,
  accessoryWidthBesideName,
  isMiniPlayerButtonAvailable,
  miniPlayerCapacityWidth,
  miniPlayerPaneMode,
  miniPlayerSlotCount,
  miniPlayerUsesWideLayout,
  recordRowWidth,
  resolveMiniPlayerControls,
  rowLayoutKey,
  trailingSlotFrame,
  wideRowCapacityWidth,
  type MeasuredRowWidth,
  type TrailingControlSlot,
} from './mini-player-controls';
import { useNativeTabContentInsetLeft, useNativeTabContentInsetRight } from '../../lib/native-tab-content-inset-store';
import { MiniPlayerActionsMenu } from './MiniPlayerActionsMenu';
import { resolveClimbRenderBoard } from '../../lib/boards/climb-render-board';
import { resolvePlayerAngle } from '../play-drawer/player-angle';
import { usePaneWallControl } from '../play-drawer/pane-wall-control-store';
import { PaneWallControlBulb } from './PaneWallControlBulb';
import { useAuth } from '../../providers/auth-provider';
import { useSegments } from 'expo-router';
import { isPlayerRoute } from '../../lib/route-segments';
import { boardSupportsMirroring } from '@boardsesh/play-view';
import { publishMeasuredMiniPlayerBar } from '../../lib/mini-player-measured-bar-store';
import { MiniPlayerLeadingButtons, MiniPlayerWallDisplayButton } from './MiniPlayerButtons';
import { useMiniPlayerButtons } from '../../lib/mini-player-buttons-preference';
import type { MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { useVerticalTabBar } from '../../hooks/use-vertical-tab-bar';
import { usePhoneSplitPaneTaken } from '../navigation/phone-split-pane-slot';
import { usePlayerButtonsPreference } from '../../lib/player-buttons-preference';
import { MiniPlayerWorkoutButtons } from './MiniPlayerWorkoutButtons';
import { useMiniPlayerWorkoutOutcome } from './use-mini-player-workout-outcome';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  queueItemUuid?: string;
  placement: AccessoryPlacement;
  testID?: string;
};

// The fixed frames at the trailing edge, left to right. A wide bar adds ⋯
// before the pair (Music's iPad layout); an iPhone keeps the pair it always had.
const PHONE_TRAILING_SLOTS: readonly TrailingControlSlot[] = ['lightbulb', 'log'];
const WIDE_TRAILING_SLOTS: readonly TrailingControlSlot[] = ['more', 'lightbulb', 'log'];
// With no board bound the bulb draws nothing, so a wide bar drops its frame
// rather than leave a gap between ⋯ and ✓. Whether a board is bound is the same
// in both placements, so this never moves a frame as the bar expands.
const WIDE_TRAILING_SLOTS_NO_BULB: readonly TrailingControlSlot[] = ['more', 'log'];
// A tablet's bar with Wall display on adds ⛶ after ⋯, where Music's iPad bar
// puts lyrics. Whether it shows follows the climber's switch, the bar's widest
// width under this window shape (`wideRowCapacityWidth`), the `/play` route and
// what claims ahead of it for this climb (Mirror, Favorite, a timed block), none
// of which changes while UIKit squeezes the open row, so its frame never comes
// or goes mid-expand. A new climb on a full bar can still bring it or drop it.
const WIDE_TRAILING_SLOTS_WALL: readonly TrailingControlSlot[] = ['more', 'wallDisplay', 'lightbulb', 'log'];
const WIDE_TRAILING_SLOTS_WALL_NO_BULB: readonly TrailingControlSlot[] = ['more', 'wallDisplay', 'log'];
// ✓ on a wide bar: Music's one large filled control.
const WIDE_LOG_GLYPH_SIZE = 32;

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  bylineColor: ColorValue;
  byline: string | null;
  thumbnailSize: number | null;
  boardConfig: BoardConfig | null;
  connectionBadge: BoardConnectionBadgeVisual | null;
  /** A wide bar sets the name in body (17pt), as Music's iPad bar does; subheadline elsewhere. */
  nameVariant: 'subheadline' | 'body';
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
  nameVariant,
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
            variant={nameVariant}
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
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: the current climb, the
 * climber's MiniPlayer buttons (#6940), then the lightbulb and the tick at the
 * trailing edge. In a timed workout block the climber's buttons step aside for
 * one-tap Fell / Sent (`useMiniPlayerWorkoutOutcome`). How many controls fit is `miniPlayerSlotCount`; which ones is
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
  const playerBoardName = playDrawerPaneProps?.boardConfig.boardName ?? null;
  const playerLayoutId = playDrawerPaneProps?.boardConfig.layoutId ?? null;
  const paneTaken = usePhoneSplitPaneTaken();
  const playerButtons = usePlayerButtonsPreference();
  // `isMiniPlayerButtonAvailable` drops Angle while the `/play` route is up,
  // and the bar offers no Fell / Sent then: the player has its own.
  const playerRouteUp = isPlayerRoute(useSegments());
  // Beside a player (the open Duo's pane, the iPad's player route) the bar is
  // that player's first row (#7000): see `miniPlayerPaneMode`.
  const paneMode = miniPlayerPaneMode({ phoneSplit, paneTaken, isTablet, playerRouteUp });
  // With the bulb chosen, the bar's bulb is that player's board control: its
  // model, its tap and its hold. With the wall button, the bar has no bulb.
  const mirrorShowsBulb = playerButtons.boardControl === 'lightbulb';
  const paneWallControl = usePaneWallControl();
  // The board the climb is drawn on, resolved the way the player resolves it, so
  // the heart, the share and Fell / Sent point at the same climb, board and angle.
  const climbBoardResolution = useMemo(() => resolveClimbRenderBoard(climb, boardConfig), [climb, boardConfig]);
  const climbBoard = climbBoardResolution?.boardConfig ?? null;
  const workout = useMiniPlayerWorkoutOutcome({
    climb,
    climbBoard: climbBoardResolution,
    reachableBoardKeys: playDrawerPaneProps?.reachableBoardKeys,
    playerRouteUp,
  });

  const isInline = placement === 'inline';
  // The controls' height. The row itself fills the platter, which is taller on iPad.
  const rowHeight = isInline ? glassSize.inline : glassSize.standard;
  // The width UIKit gave the platter. A narrow open platter (iPhone Duo's outer
  // display beside its side rail, a 320pt Display Zoom iPhone) keeps one control,
  // like the collapsed one, so the name has room to read (miniPlayerSlotCount).
  // UIKit also squeezes the hidden regular row while the bar is inline, so a
  // wide bar counts its slots from the widest width under this window shape
  // (`wideRowCapacityWidth`); an iPhone counts from the window instead.
  const sideInsetLeft = useNativeTabContentInsetLeft();
  const sideInsetRight = useNativeTabContentInsetRight();
  const layoutKey = rowLayoutKey({ windowWidth, sideInsetLeft, sideInsetRight });
  const [measuredRowWidth, setMeasuredRowWidth] = useState<MeasuredRowWidth | null>(null);
  // And its height: ~62pt open on iPad against the iPhone's 48pt (#7048). Only
  // ever grows: UIKit also squeezes the hidden regular row while the bar is
  // inline, and swapping geometry back mid-expand is the doubled-text case.
  const [platterHeight, setPlatterHeight] = useState<number | null>(null);
  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measuredWidth = Math.round(event.nativeEvent.layout.width);
      const measuredHeight = Math.round(event.nativeEvent.layout.height);
      setMeasuredRowWidth((previous) => recordRowWidth(previous, { layoutKey, measured: measuredWidth }));
      setPlatterHeight((previous) => (previous !== null && previous >= measuredHeight ? previous : measuredHeight));
    },
    [layoutKey],
  );
  // Before the first layout, guess the platter most bars measure, so the common
  // bar never redraws on its first measurement (the doubled-text snapshot case).
  const geometry = accessoryPlatterGeometry(
    platterHeight ?? (isTablet && !isInline ? TALL_PLATTER_MIN_HEIGHT : rowHeight),
  );
  const thumbnailSize = boardConfig === null ? null : geometry.thumbnailSize;
  const widthBesideName = accessoryWidthBesideName(geometry, thumbnailSize !== null);
  // iPad and the open Duo: as many as fit. An iPhone: three at most.
  const wide = isTablet || phoneSplit;
  // The open wide bar draws Music's iPad layout: ⏮ ⏭ first, ⋯ before 💡 ✓.
  const wideLayout = miniPlayerUsesWideLayout({ wide, placement });
  const rowWidth = wide ? wideRowCapacityWidth(measuredRowWidth, layoutKey) : (measuredRowWidth?.latest ?? null);
  const capacityWidth = miniPlayerCapacityWidth({ windowWidth, rowWidth, wide, verticalTabBar });
  const slotCount = miniPlayerSlotCount({ placement, rowWidth: capacityWidth, widthBesideName, wide });
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
  const bulbAvailable = bluetooth != null;
  const collapsedSlotShowsBulb = bulbAvailable && inAppBoardConnection === 'disconnected';
  const isDraft = climb.is_draft === true;
  const climbBoardName = climbBoard?.boardName ?? null;
  const climbLayoutId = climbBoard?.layoutId ?? null;
  // The climb's own board, as the player decides whether it shows ⇄.
  const supportsMirroring =
    climbBoardName !== null && climbLayoutId !== null ? boardSupportsMirroring(climbBoardName, climbLayoutId) : false;
  const isAvailable = useCallback(
    (buttonId: MiniPlayerButtonId) =>
      isMiniPlayerButtonAvailable(buttonId, {
        inTimedBlock: workout.inTimedBlock,
        mirror: supportsMirroring,
        signedIn: isAuthenticated,
        isDraft,
        angleAdjustable,
        playerRouteUp,
        tablet: isTablet,
      }),
    [workout.inTimedBlock, supportsMirroring, isAuthenticated, isDraft, angleAdjustable, playerRouteUp, isTablet],
  );
  const workoutOutcome = workout.shown !== null;
  const controls = useMemo(
    () =>
      resolveMiniPlayerControls({
        slotCount,
        layout: buttonsLayout,
        isAvailable,
        singleSlotShowsBulb: collapsedSlotShowsBulb,
        bulbAvailable,
        paneMode,
        mirrorShowsBulb,
        workoutOutcome,
        wideLayout,
        // ⋯'s sheets would present behind `/play`; the player has its own ⋯.
        moreAvailable: !playerRouteUp,
      }),
    [
      slotCount,
      buttonsLayout,
      isAvailable,
      collapsedSlotShowsBulb,
      bulbAvailable,
      paneMode,
      mirrorShowsBulb,
      workoutOutcome,
      wideLayout,
      playerRouteUp,
    ],
  );
  // A visible bulb already speaks the state; without it, only the mark shows
  // it, so the climb link says it.
  const connectionValue =
    !controls.trailing.includes('lightbulb') && inAppBoardConnection !== 'disconnected'
      ? getBoardConnectionLabel(t, { boardConnection: inAppBoardConnection, ledless, holderDisplayName })
      : undefined;

  const angleClimbUuid =
    climbBoardName === playerBoardName && climbLayoutId === playerLayoutId ? climb.uuid : undefined;
  const bluetoothConnected = bluetooth?.isConnected ?? false;
  // The climber's buttons, or Fell / Sent in a timed block. Before the climb on
  // a wide bar, as Music puts its transport; after it elsewhere.
  const buttonCluster = (
    <>
      {controls.leading.length > 0 ? (
        <MiniPlayerLeadingButtons
          queueItemUuid={queueItemUuid}
          buttonIds={controls.leading}
          climb={climb}
          climbBoard={climbBoard}
          angle={playerAngle}
          angleClimbUuid={angleClimbUuid}
          bluetoothConnected={bluetoothConnected}
          slotWidth={glassSize.inline}
          rowHeight={rowHeight}
          wideLayout={wideLayout}
        />
      ) : null}
      {controls.workout.length > 0 && workout.shown !== null ? (
        <MiniPlayerWorkoutButtons
          buttonIds={controls.workout}
          shown={workout.shown}
          slotWidth={glassSize.inline}
          rowHeight={rowHeight}
        />
      ) : null}
    </>
  );
  const trailingSlots = !wideLayout
    ? PHONE_TRAILING_SLOTS
    : controls.wallDisplay
      ? bulbAvailable
        ? WIDE_TRAILING_SLOTS_WALL
        : WIDE_TRAILING_SLOTS_WALL_NO_BULB
      : bulbAvailable
        ? WIDE_TRAILING_SLOTS
        : WIDE_TRAILING_SLOTS_NO_BULB;
  const slotShown = (slot: TrailingControlSlot) =>
    slot === 'more'
      ? controls.more && climbBoard !== null
      : slot === 'wallDisplay'
        ? controls.wallDisplay
        : controls.trailing.includes(slot);
  // What ⋯ stands in for is everything the bar is not drawing, ⛶ included.
  const menuShownButtons = useMemo<readonly MiniPlayerButtonId[]>(
    () => (controls.wallDisplay ? [...controls.leading, 'wallDisplay'] : controls.leading),
    [controls.leading, controls.wallDisplay],
  );
  const { slotsShown, trailingShift } = trailingSlotFrame(trailingSlots, slotShown);

  // UIKit can omit the central zoom-source subtree from its accessory AX tree.
  // CPP metadata belongs to this existing visible row; ordinary captures and
  // normal use leave each control's accessibility unchanged.
  return (
    <View
      // Both placements fill the frame UIKit gives them (react-native-screens sizes
      // the accessory root natively). A width worked out from the screen overshot
      // the real platter: open, by ~10pt, cramming the tick into the edge; collapsed,
      // where the bar also holds the selected and prominent tabs, by far more.
      // The height fills too, so the controls centre in iPad's taller platter
      // instead of hanging from its top (#7048).
      style={[
        styles.row,
        { minHeight: rowHeight, paddingStart: geometry.leadingInset, paddingEnd: geometry.trailingInset },
      ]}
      onLayout={handleRowLayout}
      testID={testID}
      accessible={testID ? true : undefined}
      accessibilityLabel={testID ? climb.name : undefined}
    >
      {wideLayout ? buttonCluster : null}
      <AccessoryPlayLink
        testID={`mini-player-current-${climb.uuid}`}
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
            nameVariant={wideLayout ? 'body' : 'subheadline'}
          />
        </LargeContentViewer>
      </AccessoryPlayLink>
      {/* The controls sit beside the climb gesture, never inside it, so their
          44pt tap targets are never stolen by the row's tap. Long-press on the
          bulb opens the controls sheet, as on the other lightbulbs now that a
          short press disconnects. The row stays mounted as controls appear and
          disappear: UIKit snapshots the platter between placements. */}
      {wideLayout ? null : buttonCluster}
      <View
        pointerEvents="box-none"
        style={[styles.trailingSlot, { width: slotsShown * glassSize.inline, height: rowHeight }]}
      >
        {/* UIKit also resizes the hidden regular row while the bar is inline.
            Keep the native slot frames fixed inside one pair so expansion moves
            them together. Empty slots mount no button, handler or accessibility
            element. A lone bulb (or a lone ⋯ on the open Duo's pane) shifts the
            pair to stay at the edge (`trailingSlotFrame`). The pair and its
            slots must not flatten into independent views. */}
        <View
          pointerEvents="box-none"
          collapsable={false}
          accessible={false}
          style={[
            styles.trailingPair,
            {
              width: trailingSlots.length * glassSize.inline,
              height: rowHeight,
              right: -trailingShift * glassSize.inline,
            },
          ]}
        >
          {trailingSlots.map((slot) => (
            <View
              key={`trailing-${slot}`}
              pointerEvents="box-none"
              collapsable={false}
              accessible={false}
              style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}
            >
              {!slotShown(slot) ? null : slot === 'more' ? (
                climbBoard ? (
                  <MiniPlayerActionsMenu
                    climb={climb}
                    climbBoard={climbBoard}
                    queueItemUuid={queueItemUuid}
                    isAuthenticated={isAuthenticated}
                    shownButtons={menuShownButtons}
                    isAvailable={isAvailable}
                    angleClimbUuid={angleClimbUuid}
                    bluetoothConnected={bluetoothConnected}
                    size={glassSize.inline}
                  />
                ) : null
              ) : slot === 'wallDisplay' ? (
                <MiniPlayerWallDisplayButton size={glassSize.inline} />
              ) : slot === 'lightbulb' ? (
                // Beside a player with the bulb chosen, the bulb is that
                // player's board control (#7000): its model, its tap and its hold.
                paneMode === 'mirror' && paneWallControl ? (
                  <PaneWallControlBulb control={paneWallControl} size={glassSize.inline} iconSize={22} solidGlyphs />
                ) : (
                  <BoardControlIndicator
                    size={glassSize.inline}
                    iconSize={22}
                    enableLongPress
                    solidGlyphs
                    placement={placement}
                  />
                )
              ) : (
                <LogAscentToolbarButton
                  queueItemUuid={queueItemUuid}
                  climb={climb}
                  size={glassSize.inline}
                  iconSize={wideLayout ? WIDE_LOG_GLYPH_SIZE : geometry.logGlyphSize}
                  appearance={wideLayout ? 'hero' : 'plain'}
                  placement={placement}
                />
              )}
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
    height: '100%',
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
