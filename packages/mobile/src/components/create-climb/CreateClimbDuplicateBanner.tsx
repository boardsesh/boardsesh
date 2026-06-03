import { View, Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { brandColors } from '../../theme/colors';
import { spacing, borderRadius } from '../../theme/tokens';

type DuplicateBannerProps = {
  name: string | null;
  onView?: () => void;
  onDismiss: () => void;
};

/**
 * Inline banner shown when publishing a climb collides with an existing one.
 * Shared by the Aurora and MoonBoard create screens.
 */
export function CreateClimbDuplicateBanner({ name, onView, onDismiss }: DuplicateBannerProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  return (
    <View style={[styles.banner, { backgroundColor: systemColors.secondaryBackground }]}>
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
        <Icon name="close" size={16} color={systemColors.secondaryLabel as string} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing[3],
    marginBottom: spacing[2],
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
