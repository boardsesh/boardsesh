import { StyleSheet, View } from 'react-native';
import { Text } from '../../Text';
import { StepCounter } from '../../spray-wall/StepCounter';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';

/**
 * The top of a wizard step's body: "Step 2 of 4" (when the step is counted),
 * then the step's question as a header, then an optional line under it. The bar
 * above carries no title from step 2 on (docs/mobile/mobile-sheets-vs-routes.md,
 * "Multi-step flows"), so this is where the climber reads where they are.
 */
export function WizardStepHeader({
  stepLabel,
  title,
  body,
}: {
  stepLabel: string | null;
  title: string;
  body?: string;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={styles.root}>
      {stepLabel ? <StepCounter label={stepLabel} /> : null}
      <Text variant="title2" accessibilityRole="header">
        {title}
      </Text>
      {body ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing[4],
    gap: spacing[1],
  },
});
