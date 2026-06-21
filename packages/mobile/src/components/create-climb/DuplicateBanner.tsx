import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius } from '../../theme/tokens';

type DuplicateBannerProps = {
  name: string | null;
  onView?: () => void;
  onDismiss: () => void;
};

/**
 * Inline notice shown inside the create drawer when a publish is rejected
 * because the hold pattern already exists. Rendered in-drawer (not at the
 * screen root) so the drawer's backdrop can't occlude it.
 */
export function DuplicateBanner({ name, onView, onDismiss }: DuplicateBannerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: systemColors.fill }]}>
      <View style={styles.bannerText}>
        <Text variant="footnote">
          {name
            ? t('createClimbForm.alerts.publishDuplicateNamed', { name })
            : t('createClimbForm.alerts.publishDuplicateUnnamed')}
        </Text>
        {onView ? (
          <Pressable onPress={onView} accessibilityRole="button">
            <Text variant="footnote" color={brandColors.primary}>
              {t('createClimbForm.alerts.viewMatchingClimb')}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable onPress={onDismiss} accessibilityRole="button" hitSlop={8}>
        <Icon name="close" size={16} color={systemColors.secondaryLabel} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    padding: spacing[3],
    borderRadius: borderRadius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  bannerText: {
    flex: 1,
    gap: spacing[1],
  },
});
