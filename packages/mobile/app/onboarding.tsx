import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme as usePaperTheme } from 'react-native-paper';
import { OnboardingPrompt } from '../src/components/onboarding/OnboardingPrompt';
import { OnboardingBoardRoute } from '../src/components/onboarding/OnboardingBoardRoute';
import { OnboardingLinkRoute } from '../src/components/onboarding/OnboardingLinkRoute';
import { BoardLookStep } from '../src/components/board-look/BoardLookStep';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { useBoardPreviewClimb } from '../src/hooks/use-board-preview-climb';
import { useEffectiveBoardRenderSettings } from '../src/hooks/use-native-climb-render';

/**
 * The onboarding route, which hosts the mandatory first-run flow (issue #4961).
 * Nobody reaches the app without a board bound and a board look chosen.
 *
 * Three steps, none of them skippable:
 *
 *   `/onboarding`                  the framing card — why a named board matters
 *   `/onboarding?step=board`       pick one, and take it offline while you're here
 *   `/onboarding?step=board-look`  the 2.4 "which drawing?" question
 *
 * They live behind one route so the app keeps a single launch-time interruption
 * rather than growing one per question.
 *
 * The first two steps chain directly. The third does NOT: it stays owned by
 * `BoardLookStepGate`, which refuses to present it unless there is a synced climb
 * to draw and the native renderer probe has answered `true`. That guarantee is
 * what makes a step with no exit safe, and chaining past the gate would throw it
 * away. So the board step leaves to Climbs and the gate takes over from there.
 *
 * Presented as a full-screen cover over the Climbs tab (see app/_layout.tsx) with
 * the swipe-to-dismiss gesture disabled; each step swallows Android hardware back
 * as well. The steps are variant-agnostic — this route resolves the palette from
 * the active UI variant (Liquid Glass / HIG vs Material 3) and injects it.
 */
export default function OnboardingScreen() {
  const { step } = useLocalSearchParams<{ step?: string }>();
  const { systemColors } = useTheme();
  const paperTheme = usePaperTheme();

  // Material reads MD3 roles from the Paper theme; HIG / Liquid Glass reads the
  // iOS-style system colours. Background stays opaque under the reading text in
  // both (no glass behind the copy — only the floating footer is glass).
  const { accentColor, iconColor, bodyColor, backgroundColor } = useVariantValue({
    material: {
      accentColor: paperTheme.colors.primary,
      iconColor: paperTheme.colors.primary,
      bodyColor: paperTheme.colors.onSurfaceVariant,
      backgroundColor: paperTheme.colors.background,
    },
    liquidGlass: {
      accentColor: systemColors.accent as string,
      iconColor: systemColors.accent as string,
      bodyColor: systemColors.secondaryLabel as string,
      backgroundColor: systemColors.background as string,
    },
  });

  // The seen flag is no longer written here. `OnboardingGate` now shows the flow
  // whenever there is no active board, so completion means a board is bound, and
  // `useActivateBoard` records it at the moment of the bind — on every path,
  // including the ones that never come back through this route.
  const goToBoardStep = useCallback(() => {
    router.replace({ pathname: '/onboarding', params: { step: 'board' } });
  }, []);

  if (step === 'board-look') {
    return <BoardLookRoute accentColor={accentColor} bodyColor={bodyColor} backgroundColor={backgroundColor} />;
  }

  if (step === 'link') {
    return (
      <OnboardingLinkRoute
        accentColor={accentColor}
        iconColor={iconColor}
        bodyColor={bodyColor}
        backgroundColor={backgroundColor}
      />
    );
  }

  if (step === 'board') {
    return <OnboardingBoardRoute accentColor={accentColor} bodyColor={bodyColor} backgroundColor={backgroundColor} />;
  }

  return (
    <OnboardingPrompt
      accentColor={accentColor}
      iconColor={iconColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      onContinue={goToBoardStep}
    />
  );
}

/**
 * The board-look step, plus the data it needs and the exits it takes.
 *
 * Its own component so the hooks that back it (the example-climb query, the
 * renderer capability probe) are only mounted when this step is the one being
 * shown — the first-run framing screen must not pay for them.
 */
function BoardLookRoute({
  accentColor,
  bodyColor,
  backgroundColor,
}: {
  accentColor: string;
  bodyColor: string;
  backgroundColor: string;
}) {
  const { status, preview } = useBoardPreviewClimb();
  const { boardseshRendererAvailable } = useEffectiveBoardRenderSettings();

  const leave = useCallback(() => {
    router.replace('/(tabs)/climbs');
  }, []);

  const customize = useCallback(() => {
    router.replace('/(tabs)/profile/board-look');
  }, []);

  // Deep-linked here without a board to draw (the gate never does this, but the
  // route is reachable on its own): there is nothing to choose between, so leave
  // rather than show five empty walls.
  useEffect(() => {
    if (status === 'unavailable') leave();
  }, [status, leave]);

  // The one-time "seen" flag is written by BoardLookStep, not here, and the step
  // takes a NON-OPTIONAL `preview` — so the question cannot be burned for a
  // climber who was never shown a card, whatever order these two guards end up
  // in. Keep `preview` required if this is ever refactored; it is the whole
  // guarantee.
  if (!preview) return <View style={{ flex: 1, backgroundColor }} />;

  return (
    <BoardLookStep
      accentColor={accentColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      preview={preview}
      boardseshRendererAvailable={boardseshRendererAvailable}
      onSaved={leave}
      onCustomize={customize}
    />
  );
}
