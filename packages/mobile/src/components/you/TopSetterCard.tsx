import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RawSetterSummary } from '@boardsesh/profile-stats';
import { Text } from '../Text';
import { Card } from '../Card';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';

const MATERIAL = { material: true, liquidGlass: false } as const;

type TopSetterCardProps = {
  summary: RawSetterSummary;
};

/**
 * "Top setter" — the setter whose problems the climber has sent most + how many
 * setters they've explored. Neutral copy (renders on any climber's profile).
 * Hidden by the parent when there's no resolved setter.
 */
export function TopSetterCard({ summary }: TopSetterCardProps) {
  const { t } = useTranslation('profile');
  const { systemColors, m3, brandColors } = useTheme();
  const isMaterial = useVariantValue(MATERIAL);

  if (!summary.topSetter) return null;
  const { username, count } = summary.topSetter;
  const initial = username.charAt(0).toUpperCase();

  const avatarBg = isMaterial ? m3.primaryContainer : systemColors.fill;
  const counterColor = isMaterial ? m3.onSurfaceVariant : systemColors.secondaryLabel;

  return (
    <Card
      style={styles.card}
      accessibilityLabel={t('charts.setterA11y', { setter: username, count, total: summary.distinctSetters })}
    >
      <View style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: avatarBg, borderColor: brandColors.primary }]}>
          <Text variant="headline" color={brandColors.primary}>
            {initial}
          </Text>
        </View>
        <View style={styles.body}>
          <Text variant="headline" numberOfLines={1}>
            {username}
          </Text>
          <Text variant="footnote" color={counterColor}>
            {t('charts.setterProblems', { count })}
          </Text>
        </View>
        <Text variant="footnote" color={counterColor} style={styles.counter} numberOfLines={2}>
          {t('charts.settersExplored', { count: summary.distinctSetters })}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  avatar: {
    width: spacing[10],
    height: spacing[10],
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
  counter: {
    maxWidth: spacing[16] + spacing[4],
    textAlign: 'right',
  },
});
