import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Icon } from '../Icon';
import type { AscentStatusValue } from '../../lib/ascent-status-utils';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';

type AscentStatusMarkProps = {
  status: AscentStatusValue;
  /** Outer diameter in points. */
  size?: number;
};

const RING_WIDTH = 1.5;

/**
 * The round badge in front of a log's result word: a violet disc with a bolt
 * for a flash, a green disc with a check for a send, an outlined ring with a
 * dash for a try that did not go. Shape carries the status as well as colour,
 * and callers always print the result word beside it, so the mark itself stays
 * out of the accessibility tree.
 */
export const AscentStatusMark = memo(function AscentStatusMark({ status, size = 18 }: AscentStatusMarkProps) {
  const { brandColors, systemColors } = useTheme();
  const glyphSize = Math.round(size * 0.62);
  const shape = { width: size, height: size, borderRadius: size / 2 };

  if (status === 'attempt') {
    return (
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.mark, shape, { borderWidth: RING_WIDTH, borderColor: systemColors.secondaryLabel }]}
      >
        <Icon name="minus" size={glyphSize} color={systemColors.secondaryLabel} />
      </View>
    );
  }

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.mark,
        shape,
        // The FILL role of the brand violet: white clears AA on it in both
        // schemes, which the lighter dark-scheme `primary` does not.
        { backgroundColor: status === 'flash' ? brandColors.primaryFill : iosSystemColors.systemGreen },
      ]}
    >
      <Icon name={status === 'flash' ? 'flash' : 'check.small'} size={glyphSize} color={iosSystemColors.white} />
    </View>
  );
});

const styles = StyleSheet.create({
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
