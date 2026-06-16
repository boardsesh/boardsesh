import { useCallback } from 'react';
import { router } from 'expo-router';
import { useTheme as usePaperTheme } from 'react-native-paper';
import { OnboardingCarousel } from '../src/components/onboarding/OnboardingCarousel';
import { useTheme } from '../src/providers/theme-provider';
import { useVariantValue } from '../src/theme/variants';
import { markOnboardingSeen } from '../src/lib/onboarding/onboarding-storage';
import { reportError } from '../src/lib/error-reporting';

/**
 * First-run welcome walkthrough. Presented as a full-screen cover over the
 * Climbs tab (see app/_layout.tsx) with the swipe-to-dismiss gesture disabled —
 * the user leaves via Skip, finish, or the final CTA, never an accidental drag.
 *
 * The carousel itself is variant-agnostic; this route resolves the palette from
 * the active UI variant (Liquid Glass / HIG vs Material 3) and injects it, so
 * one component serves both skins. Both exits persist the "seen" flag so the
 * tour shows exactly once; an interrupted tour (app killed mid-tour) reshows
 * because the flag is only written here.
 */
export default function OnboardingScreen() {
  const { systemColors } = useTheme();
  const paperTheme = usePaperTheme();

  // Material reads MD3 roles from the Paper theme; HIG / Liquid Glass reads the
  // iOS-style system colours. Background stays opaque under the reading text in
  // both (no glass behind the copy — only the floating footer is glass).
  const { accentColor, iconColor, inactiveDotColor, bodyColor, backgroundColor } = useVariantValue({
    material: {
      accentColor: paperTheme.colors.primary,
      iconColor: paperTheme.colors.primary,
      inactiveDotColor: paperTheme.colors.surfaceVariant,
      bodyColor: paperTheme.colors.onSurfaceVariant,
      backgroundColor: paperTheme.colors.background,
    },
    liquidGlass: {
      accentColor: systemColors.accent as string,
      iconColor: systemColors.accent as string,
      inactiveDotColor: systemColors.separator as string,
      bodyColor: systemColors.secondaryLabel as string,
      backgroundColor: systemColors.background as string,
    },
  });

  // Persist the "seen" flag without blocking the exit. If the SecureStore write
  // rejects (keychain locked / unavailable), navigation still happens — but we
  // log + report it, because a silent failure would reshow the tour on every
  // cold start. console.warn for dev visibility, reportError for production.
  const persistSeen = useCallback(() => {
    markOnboardingSeen().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to persist "seen" flag', error);
      reportError(error);
    });
  }, []);

  const dismissToHome = useCallback(() => {
    persistSeen();
    router.replace('/(tabs)/home');
  }, [persistSeen]);

  const goToBoards = useCallback(() => {
    persistSeen();
    router.replace('/boards');
  }, [persistSeen]);

  return (
    <OnboardingCarousel
      accentColor={accentColor}
      iconColor={iconColor}
      inactiveDotColor={inactiveDotColor}
      bodyColor={bodyColor}
      backgroundColor={backgroundColor}
      onDone={dismissToHome}
      onFinish={goToBoards}
    />
  );
}
