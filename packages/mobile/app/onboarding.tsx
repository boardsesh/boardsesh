import { useCallback } from 'react';
import { router } from 'expo-router';
import { useTheme as usePaperTheme } from 'react-native-paper';
import { OnboardingCarousel } from '../src/components/onboarding/OnboardingCarousel';
import { useTheme } from '../src/providers/theme-provider';
import { markOnboardingSeen } from '../src/lib/onboarding/onboarding-storage';
import { reportError } from '../src/lib/sentry';

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
  const { variant, systemColors } = useTheme();
  const paperTheme = usePaperTheme();

  const isMaterial = variant === 'material';
  // Material reads MD3 roles from the Paper theme; HIG / Liquid Glass reads the
  // iOS-style system colours. Background stays opaque under the reading text in
  // both (no glass behind the copy — only the floating footer is glass).
  const accentColor = isMaterial ? paperTheme.colors.primary : (systemColors.accent as string);
  const iconColor = isMaterial ? paperTheme.colors.primary : (systemColors.accent as string);
  const inactiveDotColor = isMaterial ? paperTheme.colors.surfaceVariant : (systemColors.separator as string);
  const bodyColor = isMaterial ? paperTheme.colors.onSurfaceVariant : (systemColors.secondaryLabel as string);
  const backgroundColor = isMaterial ? paperTheme.colors.background : (systemColors.background as string);

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

  const dismissToClimbs = useCallback(() => {
    persistSeen();
    router.replace('/(tabs)/climbs');
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
      onDone={dismissToClimbs}
      onFinish={goToBoards}
    />
  );
}
