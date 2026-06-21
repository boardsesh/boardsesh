import { memo } from 'react';
import { StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { spacing, borderRadius } from '../../theme/tokens';
import type { IconName } from '../icon-map';

const ILLUSTRATION_SIZE = 96;
const ILLUSTRATION_IMAGE_WIDTH = 240;
const ILLUSTRATION_IMAGE_HEIGHT = 360;

type OnboardingCardProps = {
  /** Glyph for this page (resolved from the card data by the carousel). */
  icon: IconName;
  /** Real app-screen illustration; when present it replaces the glyph. */
  image?: ImageSourcePropType;
  /** Already-translated heading. Resolved at the call site with a static `t()`
   * literal so the i18n orphan checker can see the keys (no `t(variable)`). */
  title: string;
  /** Already-translated body copy. */
  body: string;
  /** Already-translated secondary line under the body (optional). */
  footnote?: string;
  /** Fixed page width when used as a carousel page; omit to fill the parent. */
  width?: number;
  /** Tint for the illustration glyph (variant accent: systemColors.accent / colors.primary). */
  iconColor: string;
  /** Body/subtext colour (secondary label / onSurfaceVariant). */
  bodyColor: string;
};

/**
 * A tinted glyph (or a real captured screenshot) above a large title, body, and
 * an optional secondary line. The whole card is one accessibility element so
 * VoiceOver/TalkBack reads the heading and copy together. Memoised so it doesn't
 * re-render on unrelated parent updates.
 */
function OnboardingCardComponent({
  icon,
  image,
  title,
  body,
  footnote,
  width,
  iconColor,
  bodyColor,
}: OnboardingCardProps) {
  const accessibilityLabel = footnote ? `${title}. ${body}. ${footnote}` : `${title}. ${body}`;
  return (
    <View
      style={[styles.page, width != null ? { width } : null]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.illustration} importantForAccessibility="no-hide-descendants">
        {image ? (
          <Image source={image} style={styles.illustrationImage} contentFit="contain" accessible={false} />
        ) : (
          <Icon name={icon} size={ILLUSTRATION_SIZE} color={iconColor} />
        )}
      </View>
      <Text variant="largeTitle" style={styles.title}>
        {title}
      </Text>
      <Text variant="body" color={bodyColor} style={styles.body}>
        {body}
      </Text>
      {footnote ? (
        <Text variant="footnote" color={bodyColor} style={styles.footnote}>
          {footnote}
        </Text>
      ) : null}
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
  illustrationImage: {
    width: ILLUSTRATION_IMAGE_WIDTH,
    height: ILLUSTRATION_IMAGE_HEIGHT,
    borderRadius: borderRadius.lg,
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing[4],
  },
  body: {
    textAlign: 'center',
    maxWidth: 340,
  },
  footnote: {
    textAlign: 'center',
    maxWidth: 340,
    marginTop: spacing[4],
    opacity: 0.75,
  },
});
