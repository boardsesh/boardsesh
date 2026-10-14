import type { StyleProp, TextStyle } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';

/**
 * "Step 3 of 6" above a wizard step's title. One component for every step that
 * counts itself (the wizard's own pages, the corners and both look phases), so
 * the line reads the same everywhere: sentence case, footnote size, secondary
 * label colour. Not uppercased: a capitalised counter shouted louder than the
 * question under it.
 */
export function StepCounter({ label, style }: { label: string; style?: StyleProp<TextStyle> }) {
  const { systemColors } = useTheme();
  return (
    <Text variant="footnote" color={systemColors.secondaryLabel} style={style} testID="spray-step-counter">
      {label}
    </Text>
  );
}
