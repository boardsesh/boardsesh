import { StyleSheet, View, type ColorValue } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import type { Climb } from '@boardsesh/queue';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost, type BoardConfig } from '../../providers/drawer-host-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE, ACCESSORY_EYEBROW_TEXT_STYLE } from '../../theme/typography';
import { Text } from '../Text';
import { AccessoryClimbThumbnail } from './AccessoryClimbThumbnail';
import { useAccessoryClimbTap } from './use-accessory-climb-tap';
import { useAccessoryEyebrow, accessoryEyebrowColor } from './use-accessory-presentation';
import { LogAscentToolbarButton } from './LogAscentToolbarButton';
import { BoardControlIndicator } from './BoardControlIndicator';

type AccessoryPlacement = 'regular' | 'inline';

type NativeAccessoryClimbRowProps = {
  climb: Climb;
  placement: AccessoryPlacement;
  width: number;
};

const ACCESSORY_LEADING_INSET = spacing[1];
// Pull the tick ~20pt off the platter's right edge so it doesn't sit flush.
const ACCESSORY_TRAILING_INSET = spacing[8];
// Leading space the climb content reserves for the (absolutely-positioned)
// lightbulb. A touch less than the 44pt slot so the thumbnail tucks ~12pt closer
// to the bulb than a full slot + gap would, matching the look we want without a
// negative margin overlapping the control's tap target.
const THUMBNAIL_LEADING_INSET = glassSize.inline - spacing[3];

type ClimbLabelProps = {
  climb: Climb;
  labelColor: ColorValue;
  formattedGrade: string | null;
  showThumbnail: boolean;
  boardConfig: BoardConfig | null;
  // Status caption shown above the name in the `regular` placement only (null in
  // `inline`, where the minimized platter has no vertical room for a second line).
  eyebrow: string | null;
  eyebrowColor: ColorValue;
};

function ClimbLabel({
  climb,
  labelColor,
  formattedGrade,
  showThumbnail,
  boardConfig,
  eyebrow,
  eyebrowColor,
}: ClimbLabelProps) {
  return (
    <View style={styles.labelInner}>
      {showThumbnail ? <AccessoryClimbThumbnail climb={climb} boardConfig={boardConfig} /> : null}
      <View style={styles.labelTextColumn}>
        {eyebrow ? (
          <Text
            variant="caption1"
            color={eyebrowColor}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={ACCESSORY_EYEBROW_TEXT_STYLE}
          >
            {eyebrow}
          </Text>
        ) : null}
        <View style={styles.nameRow}>
          <Text
            variant="subheadline"
            color={labelColor}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.name}
          >
            {climb.name}
          </Text>
          {formattedGrade ? (
            <Text
              variant="subheadline"
              color={labelColor}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={styles.gradeText}
            >
              {formattedGrade}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Content for the iOS 26 tab-bar bottom accessory (Liquid Glass variant only).
 * UIKit supplies the glass platter, so this stays bare: current climb + tick. The
 * displayed climb is resolved once by {@link QueueBottomAccessory} and passed in,
 * so this component never re-gates (a second gate could blank the live platter for
 * a frame, which UIKit snapshotted as doubled text). Tap-to-open is shared with
 * the floating capsule via useAccessoryClimbTap. Its plain grade + board thumbnail
 * are tuned for the platter, so they intentionally differ from the floating
 * capsule's colorized grade.
 */
export function NativeAccessoryClimbRow({ climb, placement, width }: NativeAccessoryClimbRowProps) {
  const { boardConfig } = useDrawerHost();
  const { systemColors, brandColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const { openGesture } = useAccessoryClimbTap();
  // Eyebrow labels what the platter is showing; the tick is hidden for a peer's
  // climb (you can't log someone else's send). This adds/removes content WITHIN
  // the live row — it never re-gates the whole row, so the platter never blanks.
  const { text: eyebrowText, tone, showTick } = useAccessoryEyebrow();

  const showThumbnail = placement === 'regular' && boardConfig !== null;
  const rowHeight = placement === 'inline' ? glassSize.inline : glassSize.standard;
  const currentFormattedGrade = formatGrade(climb.difficulty);
  // Only the roomier `regular` placement has space for the second line.
  const eyebrow = placement === 'regular' ? eyebrowText : null;
  const eyebrowColor = accessoryEyebrowColor(tone, brandColors.primary, systemColors.secondaryLabel);

  return (
    <View style={[styles.row, { width, height: rowHeight }]}>
      <GestureDetector gesture={openGesture}>
        {/* tapClip reserves the leading slot via paddingLeft (not a real child),
            so the climb thumbnail tucks in close to the lightbulb. Announce the
            status caption too (even in `inline`, where it isn't drawn) so a screen
            reader gets the live / on-the-wall / up-next context. */}
        <View
          style={styles.tapClip}
          accessibilityRole="button"
          accessibilityLabel={eyebrowText ? `${eyebrowText}, ${climb.name}` : climb.name}
        >
          <View style={styles.labelSlot}>
            <ClimbLabel
              climb={climb}
              labelColor={systemColors.label}
              formattedGrade={currentFormattedGrade}
              showThumbnail={showThumbnail}
              boardConfig={boardConfig}
              eyebrow={eyebrow}
              eyebrowColor={eyebrowColor}
            />
          </View>
        </View>
      </GestureDetector>
      {/* Always reserve the tick slot's width, even when the tick is hidden (a
          peer driving the wall). Removing it would let the label area expand and
          relayout the live UIKit platter mid-session when control passes — a
          visible pop. The button inside is what comes and goes, not the slot. */}
      <View style={[styles.tickSlot, { width: glassSize.inline, height: rowHeight }]}>
        {showTick ? <LogAscentToolbarButton climb={climb} size={glassSize.inline} iconSize={24} /> : null}
      </View>
      {/* Leading board control as a content-layer element (the platter is
          UIKit-owned, so the glow lives here, not on the glass). Static state
          swap; no long-press recognizer — it would fight UIKit's own gestures.
          Positioned ABSOLUTELY on top of the climb gesture (rendered last) so its
          full 44pt tap target is never stolen by the climb-row tap — the same
          leading-control treatment the Android ClimbCapsule uses. */}
      <View style={styles.controlSlot} pointerEvents="box-none">
        {/* Long-press → controls sheet, so this platter matches the other
            lightbulbs now that a short press disconnects. */}
        <BoardControlIndicator size={glassSize.inline} iconSize={22} enableLongPress />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: ACCESSORY_LEADING_INSET,
    paddingRight: ACCESSORY_TRAILING_INSET,
  },
  // The lightbulb sits in this absolute slot on TOP of the climb gesture, so its
  // Pressable keeps a full, unobscured 44pt tap target. left matches the row's
  // leading inset; box-none lets taps outside the bulb fall through to the climb
  // gesture underneath.
  controlSlot: {
    position: 'absolute',
    left: ACCESSORY_LEADING_INSET,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  tapClip: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
    // Reserve the leading slot so the thumbnail starts just past the lightbulb.
    paddingLeft: THUMBNAIL_LEADING_INSET,
  },
  labelSlot: {
    justifyContent: 'center',
    height: '100%',
  },
  labelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
    paddingLeft: spacing[2],
    paddingRight: spacing[1],
  },
  labelTextColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    gap: spacing[2],
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontWeight: '500',
  },
  gradeText: {
    fontVariant: ['tabular-nums'],
    fontWeight: '600',
    minWidth: spacing[10],
    textAlign: 'right',
  },
  tickSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
});
