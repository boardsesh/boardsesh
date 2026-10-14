import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { useTheme } from '../../../providers/theme-provider';
import { useLocalePreference } from '../../../providers/i18n-provider';
import { useToast } from '../../../providers/toast-provider';
import { resolveLanguage } from '../../../lib/i18n/locale-preference';
import { openExternalUrl } from '../../../lib/open-url';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { reportError } from '../../../lib/error-reporting';
import { replayOnboarding } from '../../../lib/onboarding/onboarding-storage';
import { replayBoardLookStep } from '../../../lib/board-render/replay-board-look-step';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { buildGeneralModel } from './general-model';

// Translations live in the shared catalog at packages/shared/i18n/locales/<locale>/.
// We deep-link to the active language's folder so a community member lands on
// the exact files to edit.
const GITHUB_LOCALES_TREE_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';

export function GeneralSettingsScreen() {
  const { t } = useTranslation('common');
  const { themeOverride, setThemeOverride } = useTheme();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { showToast } = useToast();
  // 'system' resolves to the device locale, so the link opens the files for
  // whatever language the app is showing right now.
  const activeLocale = resolveLanguage(localePreference);

  const handleReplayWalkthrough = useCallback(() => {
    hapticLight();
    // Clear the "seen" flag BEFORE opening the tour (the await is inside
    // replayOnboarding). Ordering matters: if the replayed tour is finished or
    // skipped before the clear settles, markOnboardingSeen() could land first
    // and a late clear would wipe the flag, leaving the tour "unseen" and
    // re-showing on the next cold start.
    //
    // If the SecureStore clear rejects (keychain locked or unavailable),
    // replayOnboarding never navigates, so surface an error toast instead of the
    // row silently doing nothing. Log and report so a recurring failure shows.
    replayOnboarding(() => router.push('/onboarding')).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to replay walkthrough', error);
      reportError(error);
      showToast(t('mobile.onboarding.replayError'), 'error');
    });
  }, [showToast, t]);

  const handleReplayBoardLook = useCallback(() => {
    hapticLight();
    // Clears the "seen" flag AND puts the render mode back to `default`: the
    // gate skips anyone who has already chosen a mode, so clearing the flag
    // alone would leave the step just as invisible. Deliberately does not touch
    // the hold-colour store, unlike "Reset board look", so re-testing the step
    // costs a climber none of their accessibility setup.
    replayBoardLookStep(() => router.push({ pathname: '/onboarding', params: { step: 'board-look' } })).catch(
      (error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[board-look] Failed to replay the board look step', error);
        reportError(error);
        showToast(t('mobile.onboarding.replayError'), 'error');
      },
    );
  }, [showToast, t]);

  const model = useMemo(
    () =>
      withSettingTracking(
        buildGeneralModel({
          t,
          appearance: themeOverride,
          onAppearanceChange: (appearance) => {
            hapticSelection();
            void setThemeOverride(appearance);
          },
          language: localePreference,
          onLanguageChange: (language) => {
            hapticSelection();
            setLocalePreference(language);
          },
          activeLocale,
          onHelpTranslate: () => {
            hapticLight();
            void openExternalUrl(`${GITHUB_LOCALES_TREE_URL}/${activeLocale}`, 'more-help-translate');
          },
          onReplayWalkthrough: handleReplayWalkthrough,
          onReplayBoardLook: handleReplayBoardLook,
        }),
        'general',
      ),
    [
      t,
      themeOverride,
      setThemeOverride,
      localePreference,
      setLocalePreference,
      activeLocale,
      handleReplayWalkthrough,
      handleReplayBoardLook,
    ],
  );

  return <MoreForm model={model} />;
}
