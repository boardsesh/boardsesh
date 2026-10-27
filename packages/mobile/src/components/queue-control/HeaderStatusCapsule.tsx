// The Liquid Glass shell behind the Climbs header's status capsules: the "On the
// wall" capsule (a teammate's climb on the wall) and the "You have the board"
// capsule. One regular native-glass pill with a tint in the status tone; older
// devices and Reduce Transparency keep an opaque pill with a tinted hairline.
// The content row is the caller's; the shell owns the surface, the tap target,
// the UIKit title-view rules and the entry fade. HeaderCapsuleClimbLabel is the
// row both capsules use for a climb: a face, then the name over a grade · sends
// byline, laid out like the tab-bar accessory platter.

import { useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from 'react-native';
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
// Under this title bound (a 320pt frame beside five bar slots leaves 58pt) a
// leading avatar or glyph would squeeze the text to nothing, so it drops out.
const CAPSULE_COMPACT_BELOW = 100;

/** True when UIKit's title slot is too narrow for the capsule's leading element. */
export function useHeaderCapsuleCompact(): boolean {
  const titleMaxWidth = useContext(NativeTitleMaxWidthContext);
  return titleMaxWidth != null && titleMaxWidth < CAPSULE_COMPACT_BELOW;
}

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
  testID,
  children,
}: HeaderStatusCapsuleProps) {
  const { systemColors } = useTheme();
  const reduceMotion = useReducedMotion();
  const nativeHeader = useContext(NativeHeaderActionContext);
  const nativeGlass = useNativeGlass();

  // A tint composited over the neutral surface carries the status tone.
  const glassTintStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: withAlpha(tintColor, 0.14) }],
    [tintColor],
  );

  const capsuleStyle = [
    styles.capsule,
    { backgroundColor: systemColors.secondaryBackground, borderColor: withAlpha(tintColor, 0.35) },
  ];
  const rowStyle = [styles.row, compact && styles.rowCompact];
  const capsuleContent = (
    <>
      {nativeGlass ? null : <View pointerEvents="none" style={glassTintStyle} />}
      {onPress ? (
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
        <View
          accessible
          accessibilityRole="text"
          accessibilityLabel={accessibilityLabel}
          style={rowStyle}
          testID={testID}
        >
          {children}
        </View>
      )}
    </>
  );

  // The native glass draws its own rounded edge. Opaque fills, RN borders and
  // clipping would cover or cut that lens, and opacity entry animations flatten it.
  const capsuleRadius = (nativeHeader ? NATIVE_ACTION_SIZE : CAPSULE_HEIGHT) / 2;
  const surface = nativeGlass ? (
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
    return <View style={nativeGlass ? styles.glassWrapper : [capsuleStyle, styles.nativeCapsule]}>{surface}</View>;
  }

  if (nativeGlass) return <View style={styles.glassWrapper}>{surface}</View>;

  return (
    <Animated.View key={entryKey} entering={reduceMotion ? undefined : FadeIn.duration(180)} style={capsuleStyle}>
      {capsuleContent}
    </Animated.View>
  );
}

type HeaderCapsuleClimbLabelProps = {
  /** The face before the name; dropped when the capsule is compact. */
  avatar: ReactNode;
  name: string;
  byline: string | null;
  compact: boolean;
  /** Spoken by the Large Content Viewer when the text is too small to read. */
  largeContentTitle: string;
  onActivate?: () => void;
};

/** A face, then the climb's name over its byline: the accessory platter's row in a header capsule. */
export function HeaderCapsuleClimbLabel({
  avatar,
  name,
  byline,
  compact,
  largeContentTitle,
  onActivate,
}: HeaderCapsuleClimbLabelProps) {
  const { systemColors } = useTheme();
  return (
    <>
      {/* One tap target and one spoken label: the face is decoration here. */}
      {compact ? null : (
        <View style={styles.climbAvatar} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {avatar}
        </View>
      )}
      <LargeContentViewer title={largeContentTitle} onActivate={onActivate} style={styles.climbLines}>
        <Text
          variant="caption1"
          color={systemColors.label}
          numberOfLines={1}
          ellipsizeMode="tail"
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.climbName}
        >
          {name}
        </Text>
        {byline ? (
          <Text
            variant="caption2"
            color={systemColors.secondaryLabel}
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.climbByline}
          >
            {byline}
          </Text>
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
  climbByline: {
    fontVariant: ['tabular-nums'],
  },
});
