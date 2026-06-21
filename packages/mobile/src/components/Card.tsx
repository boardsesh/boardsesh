import { type ReactNode } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Card as PaperCard } from 'react-native-paper';
import { PressableSurface } from './PressableSurface';
import { hapticLight } from '../lib/haptics';
import { borderRadius } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { createVariantComponent } from '../theme/variants';

type CardProps = {
  children: ReactNode;
  onPress?: () => void;
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  accessibilityActions?: ReadonlyArray<AccessibilityActionInfo>;
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
};

/**
 * Card routes to a Material 3 `Card` on the Material variant and to the existing
 * Liquid Glass surface on the Liquid Glass variant. The public prop API is
 * identical for both, so call sites never change.
 */
export const Card = createVariantComponent('Card', { liquidGlass: CardGlass, material: CardMaterial });

function CardMaterial({
  children,
  onPress,
  haptic = true,
  style,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityActions,
  onAccessibilityAction,
}: CardProps) {
  const { m3 } = useTheme();
  const handlePress = () => {
    if (haptic) hapticLight();
    onPress?.();
  };

  // M3 elevated card. Paper's Card has no `contentStyle`; padding belongs on
  // `Card.Content`, which keeps the 16dp the Liquid Glass card uses. Only attach
  // onPress when given, mirroring the glass branch (no pressable affordance for a
  // static card).
  return (
    <PaperCard
      mode="elevated"
      onPress={onPress ? handlePress : undefined}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={accessibilityState}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      style={[styles.materialCard, { borderColor: m3.outlineVariant }, style]}
    >
      <PaperCard.Content style={styles.materialContent}>{children}</PaperCard.Content>
    </PaperCard>
  );
}

// Liquid Glass card — the original implementation, unchanged.
function CardGlass({
  children,
  onPress,
  haptic = true,
  style,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  accessibilityActions,
  onAccessibilityAction,
}: CardProps) {
  const { systemColors } = useTheme();

  const handlePress = () => {
    if (haptic) hapticLight();
    onPress?.();
  };

  // Hairline edge so the card reads as a distinct surface on the near-black page
  // (the soft shadow alone barely registers on dark).
  const backgroundStyle = { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator };

  if (onPress) {
    return (
      <PressableSurface
        onPress={handlePress}
        feedback="scale"
        scaleTo={0.98}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={accessibilityState}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.card, backgroundStyle, style]}
      >
        {children}
      </PressableSurface>
    );
  }

  return <View style={[styles.card, backgroundStyle, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  materialCard: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  materialContent: {
    padding: 16,
  },
});
