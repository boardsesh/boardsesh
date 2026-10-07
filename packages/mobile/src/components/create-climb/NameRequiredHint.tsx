import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';

/**
 * The line a Save tap with no name leaves in the drawer. It mounts only after
 * that tap and unmounts when the name changes, so the screen reader hears it
 * once per appearance. Rendered between the measured blocks, like the banners.
 */
type NameRequiredHintProps = {
  /** Bumps on every blank Save tap, so a repeat tap is announced again. */
  announceKey: number;
};

export function NameRequiredHint({ announceKey }: NameRequiredHintProps) {
  const { t } = useTranslation('climbs');
  const { brandColors } = useTheme();
  const message = t('mobile.create.header.nameRequired');
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
  }, [message, announceKey]);
  return (
    <Text variant="footnote" color={brandColors.error} style={styles.hint} testID="create-drawer-name-required">
      {message}
    </Text>
  );
}

const styles = StyleSheet.create({
  hint: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
  },
});
