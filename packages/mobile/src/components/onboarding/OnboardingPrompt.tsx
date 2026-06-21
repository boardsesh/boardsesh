import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { OnboardingCard } from './OnboardingCard';
import { ONBOARDING_PROMPT_CARD } from '../../lib/onboarding/onboarding-cards';
import { useOnboardingCopy } from '../../lib/onboarding/use-onboarding-copy';
import {
  trackStepViewed,
  trackTourCompleted,
  trackTourSkipped,
  trackTourStarted,
} from '../../lib/onboarding/onboarding-analytics';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';

type OnboardingPromptProps = {
  /** Primary CTA accent (HIG: systemColors.accent; Material: colors.primary). */
  accentColor: string;
  /** Illustration glyph tint. */
  iconColor: string;
  /** Body/subtext colour. */
  bodyColor: string;
  /** Opaque background under the reading text. */
  backgroundColor: string;
  /** Primary CTA — hand off to the real /boards picker (the activation action). */
  onFindBoard: () => void;
  /** Quiet exit — dismiss to Home; the Home empty state re-nudges later. */
  onLookAround: () => void;
};

/**
 * First-run framing screen. A single value-promise card (live board history)
 * whose primary button drops the user straight into the real /boards follow
 * flow — following a named board is the one action that turns board history on,
 * so understand-and-do collapse into one motion. The quiet secondary exit leaves
 * to Home without guilt; nothing is taught that the user can't yet act on.
 *
 * Variant-agnostic: the route resolves the palette from the active UI variant
 * and injects it, so one component serves both the HIG and Material skins.
 */
export function OnboardingPrompt({
  accentColor,
  iconColor,
  bodyColor,
  backgroundColor,
  onFindBoard,
  onLookAround,
}: OnboardingPromptProps) {
  const copy = useOnboardingCopy();
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  const startedAtRef = useRef<number>(Date.now());

  // Tour Started + the single Step Viewed fire once on mount.
  useEffect(() => {
    startedAtRef.current = Date.now();
    trackTourStarted();
    trackStepViewed(ONBOARDING_PROMPT_CARD, 0);
  }, []);

  const handleFindBoard = useCallback(() => {
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    trackTourCompleted(durationSeconds);
    hapticSelection();
    onFindBoard();
  }, [onFindBoard]);

  const handleLookAround = useCallback(() => {
    trackTourSkipped(ONBOARDING_PROMPT_CARD, 0);
    onLookAround();
  }, [onLookAround]);

  const footerPadding = useMemo(() => Math.max(insets.bottom, spacing[4]), [insets.bottom]);

  return (
    <View style={[styles.root, { backgroundColor, paddingTop: insets.top }]} accessibilityViewIsModal>
      <View style={styles.cardArea}>
        <OnboardingCard
          icon={ONBOARDING_PROMPT_CARD.icon}
          image={ONBOARDING_PROMPT_CARD.image}
          title={copy.title}
          body={copy.body}
          footnote={copy.footnote}
          iconColor={iconColor}
          bodyColor={bodyColor}
        />
      </View>

      <GlassSurface
        glassEffectStyle="regular"
        // Material / Android / Reduce-Transparency: an opaque tonal surface; on
        // iOS 26 the footer floats on real Liquid Glass while the copy stays opaque.
        style={[styles.footer, { paddingBottom: footerPadding }]}
      >
        <Button
          title={copy.findBoard}
          onPress={handleFindBoard}
          variant="filled"
          size="large"
          tintColor={selectByVariant(variant, { material: undefined, liquidGlass: accentColor })}
          haptic={false}
          style={styles.primary}
        />
        <Button title={copy.lookAround} onPress={handleLookAround} variant="text" size="large" haptic={false} />
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  cardArea: {
    flex: 1,
  },
  footer: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
    gap: spacing[2],
  },
  primary: {
    alignSelf: 'stretch',
  },
});
