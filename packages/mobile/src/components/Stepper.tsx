import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { useTheme } from '../providers/theme-provider';
import { useVariantValue } from '../theme/variants';
import { hapticSelection } from '../lib/haptics';
import { spacing, borderRadius } from '../theme/tokens';
import { clampStepperValue, nextHoldDelay, HOLD_INITIAL_DELAY_MS } from './Stepper.logic';

export type StepperProps = {
  /** Leading label (also the accessibility label for the whole control). */
  label: string;
  /** Current value. */
  value: number;
  /** Minimum allowed value (inclusive). */
  min: number;
  /** Maximum allowed value (inclusive). */
  max: number;
  /** Fired with the next (clamped) value when the stepper changes. */
  onChange: (nextValue: number) => void;
};

// VoiceOver / TalkBack map swipe-up / swipe-down on an `adjustable` element to these.
const ADJUST_ACTIONS = [{ name: 'increment' as const }, { name: 'decrement' as const }];

/**
 * A grouped-list quantity stepper: label on the left, a brand-tinted capsule with
 * `[ − value + ]` (value between the buttons) on the right. Tap a button to step by
 * one; press and hold to repeat (accelerating). Clamps to [min, max] and disables
 * the −/+ at its bound. Designed to sit inside the generator's grouped inset card.
 *
 * This is the "quantity stepper" idiom (value between the buttons) rather than the
 * platform `UIStepper` (which shows the value separately) — deliberate, because this
 * is a custom card, not a stock Settings form, and the rows adjust counts.
 */
export function Stepper({ label, value, min, max, onChange }: StepperProps) {
  const { systemColors, brandColors, opacity: themeOpacity, m3 } = useTheme();
  const isMaterial = useVariantValue({ material: true, liquidGlass: false });

  // The hold-repeat timer reads the latest value from a ref (not the closed-over
  // prop) and bumps it optimistically, so a fast hold accumulates steps even between
  // re-renders. The ref re-syncs to the authoritative prop on every render.
  const valueRef = useRef(value);
  valueRef.current = value;
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatCount = useRef(0);

  const decrementDisabled = value <= min;
  const incrementDisabled = value >= max;

  const applyStep = useCallback(
    (direction: 1 | -1): boolean => {
      const next = clampStepperValue(valueRef.current + direction, min, max);
      if (next === valueRef.current) return false; // already at the bound
      valueRef.current = next;
      onChange(next);
      return true;
    },
    [min, max, onChange],
  );

  const stopHold = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  const startHold = useCallback(
    (direction: 1 | -1) => {
      // Cancel any in-flight repeat first (e.g. the opposite button held on a second
      // finger) so two simultaneous holds can't orphan a timer that never stops.
      stopHold();
      // Immediate step on touch-down (a tap is one step), then repeat while held.
      if (!applyStep(direction)) return;
      hapticSelection();
      repeatCount.current = 0;
      let delay = HOLD_INITIAL_DELAY_MS;
      const repeat = () => {
        if (!applyStep(direction)) {
          stopHold();
          return;
        }
        repeatCount.current += 1;
        // Throttle the tick haptic so a fast hold doesn't buzz every frame.
        if (repeatCount.current % 2 === 0) hapticSelection();
        delay = nextHoldDelay(delay);
        holdTimer.current = setTimeout(repeat, delay);
      };
      holdTimer.current = setTimeout(repeat, delay);
    },
    [applyStep, stopHold],
  );

  // Clear any pending repeat if the row unmounts mid-hold.
  useEffect(() => stopHold, [stopHold]);

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      // Only our two registered actions step; ignore anything else (e.g. a future
      // action added to ADJUST_ACTIONS) rather than defaulting it to decrement.
      if (actionName !== 'increment' && actionName !== 'decrement') return;
      if (applyStep(actionName === 'increment' ? 1 : -1)) hapticSelection();
    },
    [applyStep],
  );

  // Material: a tonal secondary-container capsule with onSecondaryContainer glyphs
  // and a state-layer ripple (Android). Glass keeps the iOS tertiaryBackground fill +
  // violet glyphs + scale feedback.
  const controlsFill = isMaterial ? m3.secondaryContainer : systemColors.tertiaryBackground;
  const activeGlyph = isMaterial ? m3.onSecondaryContainer : brandColors.primary;
  const buttonStyle = [styles.button, isMaterial && styles.buttonMaterial];

  return (
    // The whole control is ONE adjustable a11y element: VoiceOver/TalkBack read
    // "<label>, <value>, adjustable" and map swipe up/down → increment/decrement.
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={ADJUST_ACTIONS}
      onAccessibilityAction={onAccessibilityAction}
    >
      {/* The visual row is one a11y-hidden subtree so the focusable ± buttons don't
          leak as separate VoiceOver/TalkBack targets (the wrapper above is the only
          adjustable element). `accessibilityElementsHidden` hides them on iOS,
          `importantForAccessibility="no-hide-descendants"` on Android — `accessible`
          on the wrapper alone does NOT hide focusable descendants on Android. */}
      <View
        style={[styles.row, isMaterial && styles.rowMaterial]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text variant="body" style={styles.label}>
          {label}
        </Text>
        <View style={[styles.pill, { backgroundColor: controlsFill }]}>
          <PressableSurface
            onPressIn={() => startHold(-1)}
            onPressOut={stopHold}
            disabled={decrementDisabled}
            feedback="scale"
            rippleColor={isMaterial ? m3.onSecondaryContainer : undefined}
            hitSlop={2}
            testID="stepper-decrement"
            style={[buttonStyle, decrementDisabled ? { opacity: themeOpacity.disabled } : null]}
          >
            <Icon name="minus" size={18} color={decrementDisabled ? systemColors.tertiaryLabel : activeGlyph} />
          </PressableSurface>
          <Text variant="body" color={systemColors.label} numeric style={styles.value}>
            {value}
          </Text>
          <PressableSurface
            onPressIn={() => startHold(1)}
            onPressOut={stopHold}
            disabled={incrementDisabled}
            feedback="scale"
            rippleColor={isMaterial ? m3.onSecondaryContainer : undefined}
            hitSlop={2}
            testID="stepper-increment"
            style={[buttonStyle, incrementDisabled ? { opacity: themeOpacity.disabled } : null]}
          >
            <Icon name="plus" size={18} color={incrementDisabled ? systemColors.tertiaryLabel : activeGlyph} />
          </PressableSurface>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    minHeight: 44,
    gap: spacing[3],
  },
  // M3 lifts the row to a 48dp minimum so the taller ± targets sit comfortably.
  rowMaterial: {
    minHeight: 48,
  },
  label: {
    flex: 1,
    minWidth: 0,
  },
  // One capsule holding − value +. borderRadius.full keeps the pill silhouette the
  // design language uses; overflow:hidden clips the Android ripple to the capsule.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: borderRadius.full,
    overflow: 'hidden',
  },
  // Fixed width so the −/+ don't shift as the digit count changes (e.g. 9 → 10).
  value: {
    minWidth: 40,
    textAlign: 'center',
    fontWeight: '600',
  },
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // M3 ≥48dp touch target for the ± controls.
  buttonMaterial: {
    width: 48,
    height: 48,
  },
});
