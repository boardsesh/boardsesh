import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../lib/i18n/config';
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
};

export function I18nProvider({ children }: I18nProviderProps) {
  const [isReady, setIsReady] = useState(false);
  const [localePreference, setLocalePreferenceState] = useState<LocaleOverride>('system');

  // Hydrate the persisted override and apply it before the first paint. The
  // splash screen still covers this read (it hides only once auth + fonts are
  // ready in the root layout), so there's no flash of the device-default
  // language when the user previously picked another. Device-language changes
  // while the app is backgrounded are not re-detected mid-session — detection
  // runs at launch, matching the pre-existing behaviour.
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      const stored = await getStoredLocaleOverride();
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
  }, []);

  const setLocalePreference = useCallback((next: LocaleOverride) => {
    setLocalePreferenceState(next);
    void i18n.changeLanguage(resolveLanguage(next));
    void setStoredLocaleOverride(next).catch(() => {
      // Keep the in-memory choice on a write failure so the session reflects
      // the pick; reverting would visibly snap the selection back.
    });
  }, []);

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
