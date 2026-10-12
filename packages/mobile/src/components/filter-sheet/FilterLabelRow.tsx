import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { PinToggle } from '../search/PinToggle';
import { spacing } from '../../theme/tokens';

export type FilterLabelRowProps = {
  /** The control's footnote sub-label, e.g. "Grade range". */
  label: string;
  /** A one-line hint under the label, e.g. what "Grade accuracy" means. */
  description?: string;
  /** Puts a pin toggle at the end of the row: the control has a chip in the top row. */
  onTogglePin?: () => void;
  pinned?: boolean;
  /** The pin's control name for the screen reader; defaults to `label`. */
  pinLabel?: string;
};

/**
 * The muted label line over one filter control, with an optional trailing pin
 * toggle and an optional description line under it.
 */
export const FilterLabelRow = memo(function FilterLabelRow({
  label,
  description,
  onTogglePin,
  pinned = false,
  pinLabel,
}: FilterLabelRowProps) {
  const labelText = (
    <Text variant="footnote" style={styles.label}>
      {label}
    </Text>
  );
  return (
    <>
      {onTogglePin ? (
        <View style={styles.pinnableRow}>
          {labelText}
          <PinToggle pinned={pinned} onToggle={onTogglePin} label={pinLabel ?? label} />
        </View>
      ) : (
        labelText
      )}
      {description ? (
        <Text variant="footnote" style={styles.description}>
          {description}
        </Text>
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  label: {
    opacity: 0.55,
    marginTop: spacing[1],
    marginBottom: spacing[2],
  },
  // Sits tight under the label (cancels its marginBottom) and more muted than it.
  description: {
    opacity: 0.4,
    marginTop: -spacing[2],
    marginBottom: spacing[1],
  },
  // A control's label line with a trailing pin toggle (pin the control to the chip row).
  pinnableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
