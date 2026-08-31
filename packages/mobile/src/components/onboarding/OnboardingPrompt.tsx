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
  trackTourDismissed,
  trackTourStarted,
} from '../../lib/onboarding/onboarding-analytics';
import { hapticSelection } from '../../lib/haptics';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { useBlockBack } from './use-block-back';

type OnboardingPromptProps = {
  /** Primary CTA accent (HIG: systemColors.accent; Material: colors.primary). */
  accentColor: string;
  /** Illustration glyph tint. */
  iconColor: string;
  /** Body/subtext colour. */
  bodyColor: string;
  /** Opaque background under the reading text. */
  backgroundColor: string;
  /** The only way on — continue to the board step. */
  onContinue: () => void;
};

/**
 * First-run framing screen. A single value-promise card (live board history)
 * whose one button carries on to the board step. Following a named board is the
 * action that turns board history on, so the promise and the thing that delivers
 * it sit one tap apart.
 *
 * **There is no exit** (issue #4961). The quiet "Look around first" secondary
 * used to drop the climber on Home with no board bound — where every screen is
 * an empty state and the promise this card just made never lands. Android
 * hardware back is swallowed too; `gestureEnabled: false` on the route only
 * closes the iOS half.
 *
 * Variant-agnostic: the route resolves the palette from the active UI variant
 * and injects it, so one component serves both the HIG and Material skins.
 */
export function OnboardingPrompt({
  accentColor,
  iconColor,
  bodyColor,
  backgroundColor,
  onContinue,
}: OnboardingPromptProps) {
  const copy = useOnboardingCopy();
  const insets = useSafeAreaInsets();
  const { variant } = useTheme();
  const startedAtRef = useRef<number>(Date.now());
  // Tracks whether the user chose a button. Android back is now swallowed, but a
  // nav-away (a deep link arriving mid-step) can still unmount this without an
  // answer, and the cleanup fires Dismissed so the Start resolves to a terminal
  // outcome either way.
  const resolvedRef = useRef(false);

  useBlockBack();

  // Tour Started + the single Step Viewed fire once on mount. On unmount, if no
  // button resolved the prompt, fire Dismissed (the back/kill exit).
  useEffect(() => {
    startedAtRef.current = Date.now();
    trackTourStarted();
    trackStepViewed(ONBOARDING_PROMPT_CARD, 0);
    return () => {
      if (!resolvedRef.current) {
        trackTourDismissed(ONBOARDING_PROMPT_CARD, 0);
      }
    };
  }, []);

  // Completed means "read the framing and moved on", which is all this one card
  // can attest to. The activation metric — a named board actually bound — is
  // `Onboarding Board Activated`, fired from the bind itself.
  const handleContinue = useCallback(() => {
    resolvedRef.current = true;
    const durationSeconds = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
    trackTourCompleted(durationSeconds);
    hapticSelection();
    onContinue();
  }, [onContinue]);

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
          title={copy.continueLabel}
          onPress={handleContinue}
          variant="filled"
          size="large"
          tintColor={selectByVariant(variant, { material: undefined, liquidGlass: accentColor })}
          haptic={false}
          style={styles.primary}
        />
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
