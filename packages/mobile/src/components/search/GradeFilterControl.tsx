// The grade-range affordance in the climbs search row (Material variant). Shaped
// as an M3 exposed-dropdown control — an outlined, field-height pill that reads as
// a peer of the search field beside it: a label (the current selection, or "Grade
// range") plus a trailing chevron that flips up while the inline grade rail is open.
// When a range is active it swaps the chevron for a separate clear (X) button — a
// sibling, not a nested target — so "tap body to edit" and "tap X to clear" stay
// distinct (and independently labelled) for assistive tech.

import { StyleSheet, View } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';

type GradeFilterControlProps = {
  /** Current selection text (e.g. "V4–V6"), or the resting "Grade range" label. */
  label: string;
  /** A grade range is applied — switches to the filled/clearable state. */
  active: boolean;
  /** The inline grade rail is open — flips the chevron and sets expanded state. */
  expanded: boolean;
  /** Field height; matches the search field so the two read as a matched pair. */
  height: number;
  /** Toggle the inline grade rail. */
  onPress: () => void;
  /** Clear the active range (only offered when `active`). */
  onClear?: () => void;
  toggleAccessibilityLabel: string;
  clearAccessibilityLabel: string;
  openHint: string;
  closeHint: string;
};

export function GradeFilterControl({
  label,
  active,
  expanded,
  height,
  onPress,
  onClear,
  toggleAccessibilityLabel,
  clearAccessibilityLabel,
  openHint,
  closeHint,
}: GradeFilterControlProps) {
  const { systemColors } = useTheme();
  const radius = height / 2;
  const showClear = active && onClear != null;

  return (
    <View
      style={[
        styles.control,
        { height, borderRadius: radius },
        active
          ? { backgroundColor: systemColors.fill, borderColor: 'transparent' }
          : { backgroundColor: 'transparent', borderColor: systemColors.separator },
      ]}
    >
      <PressableSurface
        onPress={onPress}
        feedback="none"
        rippleColor={systemColors.fill as string}
        accessibilityRole="button"
        accessibilityLabel={toggleAccessibilityLabel}
        accessibilityHint={expanded ? closeHint : openHint}
        accessibilityState={{ selected: active, expanded }}
        style={[styles.toggle, { borderRadius: radius }]}
      >
        <Text
          variant="subheadline"
          color={active ? systemColors.label : systemColors.secondaryLabel}
          numberOfLines={1}
          style={styles.label}
        >
          {label}
        </Text>
        {showClear ? null : (
          <Icon
            name={expanded ? 'chevron.up' : 'chevron.down'}
            size={18}
            color={systemColors.secondaryLabel as string}
          />
        )}
      </PressableSurface>
      {showClear ? (
        <PressableSurface
          onPress={onClear}
          feedback="none"
          rippleColor={systemColors.fill as string}
          rippleBorderless
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          style={styles.clearButton}
        >
          <Icon name="close" size={18} color={systemColors.secondaryLabel as string} />
        </PressableSurface>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Intrinsic width with a cap so a long range label truncates instead of pushing
  // the search field; the search field flex-grows to take the rest of the row.
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingRight: 6,
    maxWidth: 150,
  },
  toggle: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    paddingLeft: 16,
    paddingRight: 6,
    gap: 2,
  },
  label: {
    flexShrink: 1,
    fontWeight: '600',
  },
  clearButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
