import { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme as usePaperTheme } from 'react-native-paper';
import { BOARD_LOOK_STEP_SEEN_KEY } from '@boardsesh/key-value-storage';
import { OnboardingPrompt } from '../src/components/onboarding/OnboardingPrompt';
import { BoardLookStep } from '../src/components/board-look/BoardLookStep';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { markOnboardingSeen, markTipSeen } from '../src/lib/onboarding/onboarding-storage';
import { useBoardPreviewClimb } from '../src/hooks/use-board-preview-climb';
import { useEffectiveBoardRenderSettings } from '../src/hooks/use-native-climb-render';
import { reportError } from '../src/lib/error-reporting';

/**
 * The onboarding route, which hosts two independent steps.
 *
 * `/onboarding` is the first-run framing screen. `/onboarding?step=board-look`
 * is the one-time "pick your board look" question that 2.4 asks when the
 * Boardsesh drawing became the default — shown on its own to a climber who
 * already finished the tour, and after board activation on a fresh install
 * (there is no board to preview until they have picked one). Both live behind
 * this one route so the app keeps a single launch-time interruption rather than
 * growing a second one.
 *
 * First-run framing screen. Presented as a full-screen cover over the Climbs tab
 * (see app/_layout.tsx) with the swipe-to-dismiss gesture disabled — the user
 * leaves via the primary CTA (find a board) or the quiet exit (look around).
 *
 * The prompt is variant-agnostic; this route resolves the palette from the
 * active UI variant (Liquid Glass / HIG vs Material 3) and injects it. Both
 * exits persist the "seen" flag so the prompt shows exactly once; the primary
 * CTA hands off to the real /boards picker (tagged `source=onboarding` so the
 * picker auto-resolves location, frames the header, and fires the activation
 * event), returning to Climbs where the board's climbs and the one-time reveal
 * banner live. The quiet exit drops to Home.
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

  // Persist the "seen" flag without blocking the exit. If the SecureStore write
  // rejects (keychain locked / unavailable), navigation still happens — but we
  // log + report it, because a silent failure would reshow the prompt on every
  // cold start. console.warn for dev visibility, reportError for production.
  const persistSeen = useCallback(() => {
    markOnboardingSeen().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to persist "seen" flag', error);
      reportError(error);
    });
  }, []);

  const lookAround = useCallback(() => {
    persistSeen();
    router.replace('/(tabs)/home');
  }, [persistSeen]);

  const findBoard = useCallback(() => {
    persistSeen();
    // `source=onboarding` drives the framing header + location pre-resolve + the
    // activation event; returnTo defaults to Climbs, where the user browses the
    // board they just picked and the one-time reveal banner points at its wall.
    router.replace({ pathname: '/boards', params: { source: 'onboarding' } });
  }, [persistSeen]);

  if (step === 'board-look') {
    return <BoardLookRoute accentColor={accentColor} bodyColor={bodyColor} backgroundColor={backgroundColor} />;
  }

  return (
    <OnboardingPrompt
      accentColor={accentColor}
      iconColor={iconColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      onFindBoard={findBoard}
      onLookAround={lookAround}
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

  // Marked seen on arrival, not on an answer: skipping is a real answer, and a
  // force-quit mid-step still counts as having been asked. The write is fire-
  // and-forget for the same reason `markOnboardingSeen` is — a keychain failure
  // must not block the climber, but it must be reported, because silently
  // failing here re-asks on every cold start.
  useEffect(() => {
    markTipSeen(BOARD_LOOK_STEP_SEEN_KEY).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[board-look] Failed to persist "seen" flag', error);
      reportError(error);
    });
  }, []);

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
      onSkip={leave}
    />
  );
}
