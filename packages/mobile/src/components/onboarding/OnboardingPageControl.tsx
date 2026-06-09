import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_TOTAL_STEPS } from '../../lib/onboarding/onboarding-cards';
import { spacing } from '../../theme/tokens';

type OnboardingPageControlProps = {
  activeIndex: number;
  /** Active dot colour (HIG: systemColors.accent; Material: colors.primary). */
  activeColor: string;
  /** Inactive dot colour (separator / surfaceVariant). */
  inactiveColor: string;
};

const DOT_SIZE = 8;

/**
 * A row of dots, one per card, the active one tinted. Announces "Page N of 4"
 * as a single a11y element so screen-reader users hear their position; the dots
 * themselves are decorative.
 */
export function OnboardingPageControl({ activeIndex, activeColor, inactiveColor }: OnboardingPageControlProps) {
  const { t } = useTranslation('common');
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('mobile.onboarding.pageIndicator', {
        current: activeIndex + 1,
        total: ONBOARDING_TOTAL_STEPS,
      })}
    >
      {Array.from({ length: ONBOARDING_TOTAL_STEPS }, (_, index) => (
        <View
          key={index}
          importantForAccessibility="no"
          style={[
            styles.dot,
            { backgroundColor: index === activeIndex ? activeColor : inactiveColor },
            index === activeIndex ? styles.dotActive : null,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
  dotActive: {
    width: DOT_SIZE * 2.5,
  },
});
