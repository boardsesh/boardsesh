import { useCallback } from 'react';
import { router } from 'expo-router';
import { useTheme as usePaperTheme } from 'react-native-paper';
import { OnboardingPrompt } from '../src/components/onboarding/OnboardingPrompt';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { markOnboardingSeen } from '../src/lib/onboarding/onboarding-storage';
import { reportError } from '../src/lib/error-reporting';

/**
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
