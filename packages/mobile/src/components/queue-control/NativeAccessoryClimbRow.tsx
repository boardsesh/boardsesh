import { useCallback, useState } from 'react';
import { StyleSheet, View, type ColorValue, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { useEffectiveClimbStats } from '@boardsesh/board-react';
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
import { formatQuality, formatSends } from '../../lib/format-climb-stats';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { AccessoryConnectionBadge } from './AccessoryConnectionBadge';
import {
  getBoardConnectionBadgeVisual,
  getBoardConnectionLabel,
  type BoardConnectionBadgeVisual,
} from './board-control-indicator-state';
import type { AccessoryPlacement } from '../../lib/analytics-board-connect';
import { accessoryFitsBothControls } from './accessory-control-slots';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  placement: AccessoryPlacement;
  testID?: string;
};

// Measured against Apple Music's platter (iOS 27): the artwork starts 16pt in, and
// the last control's centre sits ~30pt from the right edge (8pt + half its 44pt slot).
const ACCESSORY_LEADING_INSET = spacing[4];
const ACCESSORY_TRAILING_INSET = spacing[2];
// One artwork size in both placements, as Music uses (~30pt).
const ACCESSORY_PLATTER_THUMBNAIL_SIZE = 32;
// `labelInner`'s gap after the artwork and its trailing padding.
const ACCESSORY_THUMBNAIL_GAP = spacing[2];
const ACCESSORY_LABEL_TRAILING_PADDING = spacing[1];

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

/** Grade · sends, or grade · rating when there are no sends; the grade alone otherwise. */
function useAccessoryByline(climb: Climb, boardConfig: BoardConfig | null, grade: string | null): string | null {
  const { t } = useTranslation('climbs');
  // The same live counts the list rows read, keyed on the climb's own board.
  const stats = useEffectiveClimbStats(
    (climb.boardType ?? boardConfig?.boardName ?? '') as BoardName,
    climb.layoutId ?? boardConfig?.layoutId ?? 0,
    climb.uuid,
    climb.angle,
    { ascensionistCount: climb.ascensionist_count, qualityAverage: climb.quality_average },
    { enabled: boardConfig !== null },
  );
  const isDraft = climb.is_draft === true;
  const sends = !isDraft && stats.ascensionistCount > 0 ? formatSends(stats.ascensionistCount, t) : null;
  const rating =
    stats.qualityAverage != null && parseFloat(stats.qualityAverage) > 0
      ? `${formatQuality(stats.qualityAverage)}★`
      : null;
  const parts = [grade, sends ?? rating].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: the current climb, then
 * the lightbulb and the tick at the trailing edge. The collapsed platter has room
 * for one control: the lightbulb while the board is free (so connecting stays one
 * tap away), the tick once someone holds it. A mark on the thumbnail says who
 * holds it, in both placements. The
 * displayed climb is resolved once by {@link QueueBottomAccessory} and passed in,
 * so this component never re-gates (a second gate could blank the live platter for
 * a frame, which UIKit snapshotted as doubled text). Tap-to-open is shared with
 * the floating capsule via useAccessoryClimbTap. Its plain grade + board thumbnail
 * are tuned for the platter, so they intentionally differ from the floating
 * capsule's colorized grade.
 */
export function NativeAccessoryClimbRow({ climb, placement, testID }: NativeAccessoryClimbRowProps) {
  const { boardConfig } = useDrawerHost();
  const { systemColors, brandColors } = useTheme();
  const { resolveGrade } = useDisplayGrade();
  const { openPlay, preparePlay } = useAccessoryClimbTap();
  const { t } = useTranslation('settings');
  const { bluetooth, inAppBoardConnection, ledless, holderDisplayName } = useBoardConnectionState();

  const isInline = placement === 'inline';
  const rowHeight = isInline ? glassSize.inline : glassSize.standard;
  const thumbnailSize = boardConfig === null ? null : ACCESSORY_PLATTER_THUMBNAIL_SIZE;
  // The width UIKit gave the platter. A narrow open platter (iPhone Duo's outer
  // display beside its side rail, a 320pt Display Zoom iPhone) keeps one control,
  // like the collapsed one, so the name has room to read (accessoryFitsBothControls).
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    const measuredWidth = Math.round(event.nativeEvent.layout.width);
    setRowWidth((previous) => (previous === measuredWidth ? previous : measuredWidth));
  }, []);
  const widthBesideName =
    ACCESSORY_LEADING_INSET +
    (thumbnailSize === null ? 0 : thumbnailSize + ACCESSORY_THUMBNAIL_GAP) +
    ACCESSORY_LABEL_TRAILING_PADDING +
    2 * glassSize.inline +
    ACCESSORY_TRAILING_INSET;
  const singleControlSlot = isInline || !accessoryFitsBothControls(rowWidth, widthBesideName);
  // The platter shows a plain (non-colorized) grade; only the label swaps to the
  // Boardsesh grade when the toggle is on and a trusted one exists.
  const currentFormattedGrade = resolveGrade(climb, boardConfig?.boardName).label;
  const byline = useAccessoryByline(climb, boardConfig, currentFormattedGrade);

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
  // A visible bulb already speaks the state; with one slot, only the mark shows
  // it, so the climb link says it.
  const connectionValue =
    singleControlSlot && inAppBoardConnection !== 'disconnected'
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
      {/* The trailing controls sit beside the climb gesture, never inside it, so
          their 44pt tap targets are never stolen by the row's tap. Long-press on
          the bulb opens the controls sheet, as on the other lightbulbs now that a
          short press disconnects. Collapsed or narrow, the one slot swaps its child
          in place and the row never remounts: UIKit snapshots the platter between
          placements. */}
      {singleControlSlot ? (
        <View style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}>
          {collapsedSlotShowsBulb ? (
            <BoardControlIndicator
              size={glassSize.inline}
              iconSize={22}
              enableLongPress
              solidGlyphs
              placement={placement}
            />
          ) : (
            <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} placement={placement} />
          )}
        </View>
      ) : (
        <>
          <View style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}>
            <BoardControlIndicator
              size={glassSize.inline}
              iconSize={22}
              enableLongPress
              solidGlyphs
              placement={placement}
            />
          </View>
          <View style={[styles.controlSlot, { width: glassSize.inline, height: rowHeight }]}>
            <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} placement={placement} />
          </View>
        </>
      )}
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
});
