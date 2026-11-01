import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { Button } from '../Button';
import type { IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * The iPad detail-pane "nothing to show yet" placeholder, shared by `IpadPlayPane`
 * (no board resolved) and `PlayDrawer`'s pane branch (no climb selected) so the two
 * states can't drift. De-emphasis uses the theme label roles (secondaryLabel /
 * tertiaryLabel for the icon) rather than opacity, so it deepens correctly in dark mode and
 * matches adjacent text; the icon is an adaptive system colour, not a fixed gray.
 * Callers pass the resolved safe-area padding (a top-of-shell column owns its inset).
 * The phone split's no-board state adds a call to action (`actionTitle` + `onAction`).
 */
export const PanePlaceholder = memo(function PanePlaceholder({
  title,
  subtitle,
  paddingTop,
  paddingBottom,
  icon = 'search',
  actionTitle,
  onAction,
}: {
  title: string;
  subtitle: string;
  paddingTop: number;
  paddingBottom: number;
  icon?: IconName;
  actionTitle?: string;
  onAction?: () => void;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.root, { paddingTop, paddingBottom }]}>
      <Icon name={icon} size={40} color={systemColors.tertiaryLabel} />
      <Text variant="headline" color={systemColors.secondaryLabel} style={styles.title}>
        {title}
      </Text>
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.subtitle}>
        {subtitle}
      </Text>
      {actionTitle && onAction ? (
        <Button title={actionTitle} onPress={onAction} variant="filled" style={styles.action} />
      ) : null}
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
  action: { marginTop: spacing[3] },
});
