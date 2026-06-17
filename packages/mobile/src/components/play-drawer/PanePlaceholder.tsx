import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * The iPad detail-pane "nothing to show yet" placeholder, shared by `IpadPlayPane`
 * (no board resolved) and `PlayDrawer`'s pane branch (no climb selected) so the two
 * states can't drift. De-emphasis uses the theme label roles (secondaryLabel /
 * tertiaryLabel) rather than opacity, so it deepens correctly in dark mode and
 * matches adjacent text; the icon is an adaptive system colour, not a fixed gray.
 * Callers pass the resolved safe-area padding (a top-of-shell column owns its inset).
 */
export const PanePlaceholder = memo(function PanePlaceholder({
  title,
  subtitle,
  paddingTop,
  paddingBottom,
}: {
  title: string;
  subtitle: string;
  paddingTop: number;
  paddingBottom: number;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.root, { paddingTop, paddingBottom }]}>
      <Icon name="search" size={40} color={systemColors.tertiaryLabel} />
      <Text variant="headline" color={systemColors.secondaryLabel} style={styles.title}>
        {title}
      </Text>
      <Text variant="subheadline" color={systemColors.tertiaryLabel} style={styles.subtitle}>
        {subtitle}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[6],
    gap: spacing[2],
  },
  title: { marginTop: spacing[2], textAlign: 'center' },
  subtitle: { textAlign: 'center' },
});
