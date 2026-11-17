import type { Climb } from '@boardsesh/queue';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { wallGlowSurfaces } from '../../theme/colors';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { Icon } from '../Icon';
import { LargeContentViewer } from '../LargeContentViewer';
import {
  useWallGlowLayer,
  wallGlowBlendFor,
  type WallGlowInput,
  type WallGlowLayer,
} from '../play-drawer/use-wall-glow';
import { WallGlow } from '../play-drawer/WallGlow';
import { Text } from '../Text';
import { HeaderCapsuleClimbLabel, HeaderStatusCapsule, useHeaderCapsuleCompact } from './HeaderStatusCapsule';
const CAPSULE_GLYPH_SIZE = 16;
export type HeldClimbCapsuleProps = {
  climb: Climb;
  ledless: boolean;
  toneColor: string;
  onPress: () => void;
  onLongPress: () => void;
  accessibilityActions: { name: string; label: string }[] | undefined;
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
  accessibilityHint: string;
};

export function BoardHeldCapsuleView({
  ledless,
  localConnected,
  onPress,
  onLongPress: handleLongPress,
  accessibilityActions,
  onAccessibilityAction: handleAccessibilityAction,
  accessibilityHint,
}: Omit<HeldClimbCapsuleProps, 'climb' | 'toneColor'> & { localConnected: boolean }) {
  const { t } = useTranslation('settings');
  const { systemColors, brandColors, colorScheme } = useTheme();
  const compact = useHeaderCapsuleCompact();
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
  const plainGlow = !ledless && localConnected ? emptyGlow : null;
  const toneColor = ledless ? brandColors.primary : brandColors.warning;
  const statusLabel = t(ledless ? 'ble.barControl.wallHeldLabel' : 'ble.barControl.youHaveBoard');
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
          emphasized
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
}
export function HeldClimbCapsuleView({
  grade,
  sendsDetail,
  glow,
  climb,
  ledless,
  toneColor,
  onPress,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
  accessibilityHint,
}: HeldClimbCapsuleProps & { grade: string | null; sendsDetail: string | null; glow: WallGlowInput | null }) {
  const { t } = useTranslation('settings');
  const { colorScheme } = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const glowLayer = useWallGlowLayer(glow, size.width, size.height, colorScheme === 'dark' ? 'dark' : 'light', 'full');
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
  }, []);

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

const styles = StyleSheet.create({
  labelViewer: {
    // A flex:1 label has zero intrinsic width in a UIKit navigation title view.
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    flexShrink: 1,
    minWidth: 0,
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
