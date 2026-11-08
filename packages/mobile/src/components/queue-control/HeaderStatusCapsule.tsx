// The Liquid Glass shell behind the Climbs header's status capsules: the "On the
// wall" capsule (the climb lit on the wall) and the "You have the board"
// capsule. One regular native-glass pill with a tint in the status tone; older
// devices and Reduce Transparency keep an opaque pill with a tinted hairline.
// The content row is the caller's; the shell owns the surface, the tap target,
// the UIKit title-view rules and the entry fade. HeaderCapsuleClimbLabel is the
// row both capsules use for a climb: a face, then the name, over an optional
// byline (a stale climb's "20m ago"). The Android app bar's wall pill
// (WallStatusCapsule's Material skin) draws the same row in M3 type
// (`skin="material"`) and reads the same width rules from its measured slot.
// A held climb can supply the wall button's opaque patterned surface in place
// of glass, keeping the same native title host and tap target.
// No × (#7281): every room it took came out of the climb's name beside the
// angle. A capsule that can be hidden is swiped left (`WallCapsuleSwipe`), and
// the screen-reader Hide is its accessibility action. In a too-narrow title
// slot the leading face drops out.

import { useContext, useMemo, type ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type ColorValue,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { PressableSurface } from '../PressableSurface';
import { GlassSurface } from '../GlassSurface';
import { NativeHeaderActionContext, NativeTitleMaxWidthContext } from '../chrome/native-header-action-context';
import { NATIVE_ACTION_SIZE } from '../chrome/GlassActionToolbar';

// The native header's bar height, so a name over a byline fits at the 1.2 font cap.
const CAPSULE_HEIGHT = glassSize.bar;
// The leading-glyph → text → trailing gap and the trailing inset, each 2pt under
// spacing[2] / spacing[3] so the text keeps more of the title slot. The spacing
// scale has no 6 or 10.
const CAPSULE_GAP = 6;
const CAPSULE_PADDING_END = 10;
// Under this title bound (a 320pt Display Zoom frame leaves 96pt) a leading
// glyph would squeeze the text to nothing, so it drops out, and an age may cut.
const CAPSULE_COMPACT_BELOW = 100;
// A face costs the name 24pt, so it shows only where the name keeps room: from a
// 130pt title bound. Between the iPhone's matched islands that is every phone
// (375pt leaves 151pt) except a 320pt Display Zoom bar (96pt).
const CAPSULE_FACE_MIN_WIDTH = 130;
/**
 * True when a title slot this wide is too narrow for the capsule's leading
 * element. An unknown width (no bound yet) is never compact.
 */
export function headerCapsuleCompact(titleWidth: number | undefined): boolean {
  return titleWidth != null && titleWidth < CAPSULE_COMPACT_BELOW;
}
/** True when a title slot this wide leaves the climb's name room beside a face. */
export function headerCapsuleFaceFits(titleWidth: number | undefined): boolean {
  return titleWidth == null || titleWidth >= CAPSULE_FACE_MIN_WIDTH;
}
/** True when UIKit's title slot is too narrow for the capsule's leading element. */
export function useHeaderCapsuleCompact(): boolean {
  return headerCapsuleCompact(useContext(NativeTitleMaxWidthContext));
}
/** True when UIKit's title slot leaves the climb's name room beside a face. */
export function useHeaderCapsuleFaceFits(): boolean {
  return headerCapsuleFaceFits(useContext(NativeTitleMaxWidthContext));
}

/**
 * The line under the climb's name: the grade, then one fact (sends, who lit it,
 * or how long ago). The grade never cuts; the fact ends in "…" when the capsule
 * runs out of room, unless `fixed` (an age, which a cut would make wrong).
 */
export type HeaderCapsuleByline = { grade: string | null; detail: string | null; fixed?: boolean };

type HeaderStatusCapsuleProps = {
  /** The status tone: amber for lit LEDs, the brand tone for a wall with no lights. */
  tintColor: string;
  /** Remount key for the entry fade, e.g. the climb on the wall. */
  entryKey: string;
  /** Omit for a capsule that only states something; it then reads as text. */
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** From {@link useHeaderCapsuleCompact}: the leading element has dropped out. */
  compact: boolean;
  /** An opaque decorative surface, clipped to the capsule instead of glass/tint. */
  background?: { content: ReactNode; color: string; borderColor: string };
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
  children: ReactNode;
};

export function HeaderStatusCapsule({
  tintColor,
  entryKey,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
  accessibilityLabel,
  accessibilityHint,
  compact,
  background,
  onLayout,
  testID,
  children,
}: HeaderStatusCapsuleProps) {
  const { systemColors } = useTheme();
  const reduceMotion = useReducedMotion();
  const nativeHeader = useContext(NativeHeaderActionContext);
  const nativeGlass = useNativeGlass();
  const showsGlass = nativeGlass && background === undefined;

  // A tint composited over the neutral surface carries the status tone.
  const glassTintStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: withAlpha(tintColor, 0.14) }],
    [tintColor],
  );

  const capsuleStyle = [
    styles.capsule,
    {
      backgroundColor: background?.color ?? systemColors.secondaryBackground,
      borderColor: background?.borderColor ?? withAlpha(tintColor, 0.35),
    },
  ];
  const rowStyle = [styles.row, compact && styles.rowCompact];
  const mainTarget = onPress ? (
    <PressableSurface
      onPress={onPress}
      onLongPress={onLongPress}
      feedback={nativeHeader ? 'none' : 'scale'}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={rowStyle}
      testID={testID}
    >
      {children}
    </PressableSurface>
  ) : (
    <View accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel} style={rowStyle} testID={testID}>
      {children}
    </View>
  );
  const capsuleContent = (
    <>
      {background ? (
        <View
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          {background.content}
        </View>
      ) : showsGlass ? null : (
        <View pointerEvents="none" style={glassTintStyle} />
      )}
      {mainTarget}
    </>
  );

  // The native glass draws its own rounded edge. Opaque fills, RN borders and
  // clipping would cover or cut that lens, and opacity entry animations flatten it.
  const capsuleRadius = (nativeHeader ? NATIVE_ACTION_SIZE : CAPSULE_HEIGHT) / 2;
  const surface = showsGlass ? (
    <GlassSurface
      glassEffectStyle="regular"
      tintColor={withAlpha(tintColor, 0.14)}
      borderRadius={capsuleRadius}
      style={[styles.glassCapsule, nativeHeader ? styles.nativeGlassCapsule : null]}
    >
      {capsuleContent}
    </GlassSurface>
  ) : (
    capsuleContent
  );

  // UIKit owns this title view's layout and navigation transitions. A keyed
  // Reanimated entering transition can mutate it while the bar is laying out.
  if (nativeHeader) {
    return (
      <View style={showsGlass ? styles.glassWrapper : [capsuleStyle, styles.nativeCapsule]} onLayout={onLayout}>
        {surface}
      </View>
    );
  }

  if (showsGlass)
    return (
      <View style={styles.glassWrapper} onLayout={onLayout}>
        {surface}
      </View>
    );

  return (
    <Animated.View
      key={entryKey}
      entering={reduceMotion ? undefined : FadeIn.duration(180)}
      style={capsuleStyle}
      onLayout={onLayout}
    >
      {capsuleContent}
    </Animated.View>
  );
}

type HeaderCapsuleClimbLabelProps = {
  /** The face before the name; none when null, and dropped when the capsule is compact. */
  avatar: ReactNode | null;
  name: string;
  byline: HeaderCapsuleByline | null;
  compact: boolean;
  /** Spoken by the Large Content Viewer when the text is too small to read. */
  largeContentTitle: string;
  onActivate?: () => void;
  /** Patterned surfaces use their contrast-checked foreground for both lines. */
  textColor?: ColorValue;
  textStyle?: StyleProp<TextStyle>;
  /**
   * The type and colour roles. `glass` (default): the HIG caption pair in label
   * colours. `material`: M3 titleSmall over a labelMedium byline, both in
   * `onTertiaryContainer`, the ink on the Android app-bar pill's amber fill.
   */
  skin?: 'glass' | 'material';
};

/** An optional face, then the climb's name over its grade and one fact. */
export function HeaderCapsuleClimbLabel({
  avatar,
  name,
  byline,
  compact,
  largeContentTitle,
  onActivate,
  textColor,
  textStyle,
  skin = 'glass',
}: HeaderCapsuleClimbLabelProps) {
  const { systemColors, m3 } = useTheme();
  const material = skin === 'material';
  // M3 titleSmall is 14/20 medium, `label`'s metrics; labelMedium is 12/16
  // medium, `footnote` at medium weight.
  const nameVariant = material ? 'label' : 'caption1';
  const bylineVariant = material ? 'footnote' : 'caption2';
  const nameColor = textColor ?? (material ? m3.onTertiaryContainer : systemColors.label);
  const bylineColor = textColor ?? (material ? m3.onTertiaryContainer : systemColors.secondaryLabel);
  const nameSkinStyle = material ? styles.climbNameMaterial : null;
  const bylineSkinStyle = material ? styles.climbBylineMaterial : null;
  return (
    <>
      {/* One tap target and one spoken label: the face is decoration here. */}
      {compact || avatar == null ? null : (
        <View style={styles.climbAvatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {avatar}
        </View>
      )}
      <LargeContentViewer title={largeContentTitle} onActivate={onActivate} style={styles.climbLines}>
        <Text
          variant={nameVariant}
          color={nameColor}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={[styles.climbName, nameSkinStyle, textStyle]}
        >
          {name}
        </Text>
        {byline && (byline.grade || byline.detail) ? (
          <View style={styles.bylineRow}>
            {byline.grade ? (
              <Text
                variant={bylineVariant}
                color={bylineColor}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={[styles.climbByline, bylineSkinStyle, styles.bylineGrade, textStyle]}
              >
                {byline.grade}
              </Text>
            ) : null}
            {byline.detail ? (
              <Text
                variant={bylineVariant}
                color={bylineColor}
                numberOfLines={1}
                ellipsizeMode="tail"
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={[
                  styles.climbByline,
                  bylineSkinStyle,
                  byline.fixed ? styles.bylineFixed : styles.bylineDetail,
                  textStyle,
                ]}
              >
                {byline.grade ? ` · ${byline.detail}` : byline.detail}
              </Text>
            ) : null}
          </View>
        ) : null}
      </LargeContentViewer>
    </>
  );
}

const styles = StyleSheet.create({
  glassWrapper: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
  glassCapsule: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
  },
  nativeGlassCapsule: {
    height: NATIVE_ACTION_SIZE,
  },
  capsule: {
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  nativeCapsule: {
    height: NATIVE_ACTION_SIZE,
    borderRadius: NATIVE_ACTION_SIZE / 2,
  },
  row: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: '100%',
    paddingStart: spacing[1],
    paddingEnd: CAPSULE_PADDING_END,
    gap: CAPSULE_GAP,
  },
  // Without the leading element the text starts at the trailing inset, so it sits evenly.
  rowCompact: {
    paddingStart: CAPSULE_PADDING_END,
  },
  climbAvatar: {
    flexShrink: 0,
  },
  climbLines: {
    // A flex:1 label has zero intrinsic width in a UIKit navigation title view.
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  climbName: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  climbNameMaterial: {
    fontWeight: '500',
  },
  climbByline: {
    fontVariant: ['tabular-nums'],
  },
  climbBylineMaterial: {
    fontWeight: '500',
  },
  // The grade and its fact sit on one line; only the fact gives way.
  bylineRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexShrink: 1,
    minWidth: 0,
  },
  bylineGrade: {
    flexShrink: 0,
  },
  bylineFixed: {
    flexShrink: 0,
  },
  bylineDetail: {
    flexShrink: 1,
    minWidth: 0,
  },
});
