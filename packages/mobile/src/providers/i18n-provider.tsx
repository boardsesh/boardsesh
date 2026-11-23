import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../lib/i18n/config';
import { setGradeFormatLocale } from '../lib/grade-format-preference';
import { syncDocumentLanguage } from '../lib/i18n/document-language';
import {
  getStoredLocaleOverride,
  resolveLanguage,
  setStoredLocaleOverride,
  type LocaleOverride,
} from '../lib/i18n/locale-preference';

type LocalePreference = {
  /** The user's raw stored choice, including `'system'`. Drives the settings UI. */
  localePreference: LocaleOverride;
  /** Persist a new choice and switch i18next to the resolved language. */
  setLocalePreference: (next: LocaleOverride) => void;
};

const LocaleContext = createContext<LocalePreference | null>(null);

type I18nProviderProps = {
  children: ReactNode;
  initialLocale?: LocaleOverride;
  persistPreferences?: boolean;
};

export function I18nProvider({ children, initialLocale, persistPreferences = true }: I18nProviderProps) {
  const [isReady, setIsReady] = useState(false);
  const [localePreference, setLocalePreferenceState] = useState<LocaleOverride>(initialLocale ?? 'system');
  const resolvedLanguage = resolveLanguage(localePreference);

  useEffect(() => {
    syncDocumentLanguage(resolvedLanguage);
    // Spanish, French, German and Italian climbers default to Font grades until they pick one.
    setGradeFormatLocale(resolvedLanguage);
  }, [resolvedLanguage]);

  // Hydrate the persisted override and apply it before the first paint. The
  // splash screen still covers this read (it hides only once auth + fonts are
  // ready in the root layout), so there's no flash of the device-default
  // language when the user previously picked another. Device-language changes
  // while the app is backgrounded are not re-detected mid-session — detection
  // runs at launch, matching the pre-existing behaviour.
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const stored = initialLocale ?? (await getStoredLocaleOverride());
      if (cancelled) return;
      setLocalePreferenceState(stored);
      const language = resolveLanguage(stored);
      if (language !== i18n.language) {
        await i18n.changeLanguage(language);
      }
    }
    hydrate()
      .catch(() => {
        // A SecureStore read failure (rare) leaves us on the device-detected
        // default rather than crashing — the app stays usable, the override is
        // lost for this session only.
      })
      .finally(() => {
        if (!cancelled) setIsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialLocale]);

  const setLocalePreference = useCallback(
    (next: LocaleOverride) => {
      setLocalePreferenceState(next);
      void i18n.changeLanguage(resolveLanguage(next));
      if (persistPreferences)
        void setStoredLocaleOverride(next).catch(() => {
          // Keep the in-memory choice on a write failure so the session reflects
          // the pick; reverting would visibly snap the selection back.
        });
    },
    [persistPreferences],
  );

  const localeValue = useMemo<LocalePreference>(
    () => ({ localePreference, setLocalePreference }),
    [localePreference, setLocalePreference],
  );

  if (!isReady) {
    return null;
  }

  return (
    <I18nextProvider i18n={i18n}>
      <LocaleContext value={localeValue}>{children}</LocaleContext>
    </I18nextProvider>
  );
}

/** Access the language override + setter. Must be called inside an I18nProvider. */
export function useLocalePreference(): LocalePreference {
  const value = useContext(LocaleContext);
  if (value === null) {
    throw new Error('useLocalePreference must be used within an I18nProvider');
  }
  return value;
}
