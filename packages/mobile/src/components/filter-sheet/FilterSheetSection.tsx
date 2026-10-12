import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { PinToggle } from '../search/PinToggle';
import { spacing } from '../../theme/tokens';

export type FilterSheetSectionProps = {
  /** The group's headline, e.g. "Difficulty". */
  title: string;
  /** The first group sits tighter under the sheet's top bar. */
  first?: boolean;
  /** Puts a pin toggle beside the headline, for a group that is one control. */
  onTogglePin?: () => void;
  pinned?: boolean;
  /** The pin's control name for the screen reader; defaults to `title`. */
  pinLabel?: string;
  children?: ReactNode;
};

/**
 * One flat group of a filter sheet: a headline, then its controls. No card and
 * no accordion: the generous top pad and the headline weight are what separate
 * the groups.
 */
export const FilterSheetSection = memo(function FilterSheetSection({
  title,
  first = false,
  onTogglePin,
  pinned = false,
  pinLabel,
  children,
}: FilterSheetSectionProps) {
  const header = (
    <Text variant="headline" accessibilityRole="header" style={styles.header}>
      {title}
    </Text>
  );
  return (
    <View style={first ? styles.sectionFirst : styles.section}>
      {onTogglePin ? (
        <View style={styles.pinnableRow}>
          {header}
          <PinToggle pinned={pinned} onToggle={onTogglePin} label={pinLabel ?? title} />
        </View>
      ) : (
        header
      )}
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  // A generous top pad separates the groups; the first sits tighter under the
  // sheet header.
  section: {
    paddingTop: spacing[5],
  },
  sectionFirst: {
    paddingTop: spacing[2],
  },
  // More prominent than the muted footnote sub-labels, so the flat sheet reads
  // as inset groups without accordions.
  header: {
    marginBottom: spacing[3],
  },
  pinnableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
