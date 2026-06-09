import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { spacing } from '../../theme/tokens';
import type { IconName } from '../icon-map';

const ILLUSTRATION_SIZE = 96;

type OnboardingCardProps = {
  /** Glyph for this page (resolved from the card data by the carousel). */
  icon: IconName;
  /** Already-translated heading. Resolved at the call site with a static `t()`
   * literal so the i18n orphan checker can see the keys (no `t(variable)`). */
  title: string;
  /** Already-translated body copy. */
  body: string;
  /** Page width — each card fills exactly one viewport so paging snaps cleanly. */
  width: number;
  /** Tint for the illustration glyph (variant accent: systemColors.accent / colors.primary). */
  iconColor: string;
  /** Body/subtext colour (secondary label / onSurfaceVariant). */
  bodyColor: string;
};

/**
 * One full-width welcome page: a tinted glyph above a large title and body. The
 * whole card is one accessibility element so VoiceOver/TalkBack reads the
 * heading and body together as the user pages across. Memoised so FlatList row
 * recycling doesn't re-render unchanged pages.
 */
function OnboardingCardComponent({ icon, title, body, width, iconColor, bodyColor }: OnboardingCardProps) {
  return (
    <View style={[styles.page, { width }]} accessible accessibilityRole="text" accessibilityLabel={`${title}. ${body}`}>
      <View style={styles.illustration} importantForAccessibility="no-hide-descendants">
        <Icon name={icon} size={ILLUSTRATION_SIZE} color={iconColor} />
      </View>
      <Text variant="largeTitle" style={styles.title}>
        {title}
      </Text>
      <Text variant="body" color={bodyColor} style={styles.body}>
        {body}
      </Text>
    </View>
  );
}

export const OnboardingCard = memo(OnboardingCardComponent);

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[8],
  },
  illustration: {
    marginBottom: spacing[8],
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  body: {
    textAlign: 'center',
    maxWidth: 340,
  },
});
