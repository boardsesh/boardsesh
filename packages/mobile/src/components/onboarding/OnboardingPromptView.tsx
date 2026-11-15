import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ONBOARDING_PROMPT_CARD } from '../../lib/onboarding/onboarding-cards';
import { useOnboardingCopy } from '../../lib/onboarding/use-onboarding-copy';
import { spacing } from '../../theme/tokens';
import { SheetTopBar } from '../SheetTopBar';
import { OnboardingCard } from './OnboardingCard';

export type OnboardingPromptViewProps = {
  onImageDisplayed?: () => void;
  onImageError?: (error: unknown) => void;
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
 * whose one action, the top bar's trailing confirm, carries on to the board step. Following a named board is the
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
export function OnboardingPromptView({
  iconColor,
  bodyColor,
  backgroundColor,
  onContinue,
  onImageDisplayed,
  onImageError,
}: OnboardingPromptViewProps) {
  const copy = useOnboardingCopy();
  const insets = useSafeAreaInsets();
  // The route hides the native header (a transparentModal), so the step draws
  // its own top bar. No leading action: this step has no exit (see above).
  return (
    <View
      style={[
        styles.root,
        { backgroundColor, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing[4]) },
      ]}
      accessibilityViewIsModal
    >
      <SheetTopBar
        title=""
        trailing={{ kind: 'forward', label: copy.continueLabel, onPress: onContinue, prominent: true }}
      />
      <View style={styles.cardArea}>
        <OnboardingCard
          icon={ONBOARDING_PROMPT_CARD.icon}
          image={ONBOARDING_PROMPT_CARD.image}
          onImageDisplayed={onImageDisplayed}
          onImageError={onImageError}
          title={copy.title}
          body={copy.body}
          footnote={copy.footnote}
          iconColor={iconColor}
          bodyColor={bodyColor}
        />
      </View>
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
});
