// The store prompt in the browser app (app.boardsesh.com).
//
// About 164 people a month open the browser app on a phone, and until this
// there was no way from it to the App Store or Google Play (#6027). 131 of
// them are signed in, so the prompt sits on three screens: the read-only climb
// view a search result lands on, the login screen, and the Home feed.
//
// Shown only when the browser can install from a store (see
// `detectStorePlatform`): a desktop browser gets nothing, because there the
// browser app is the product.
//
// One store, not both: the user agent already says which one applies, and a
// phone-width row has room for one button.

import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Text } from './Text';
import { track } from '../lib/analytics';
import { reportError } from '../lib/error-reporting';
import { getPreference, setPreference } from '../lib/preference-store';
import {
  APP_INSTALL_CLICK_EVENT,
  buildBrowserAppInstallClickProperties,
  detectStorePlatform,
  storeUrlForBrowserApp,
  type StorePlatform,
  type StorePromptSurface,
} from '../lib/store-links';
import { useTheme } from '../providers/theme-provider';
import { borderRadius, spacing } from '../theme/tokens';
import type { AppStorePromptProps } from './AppStorePrompt.types';

/** Not a secret and not an auth token, so the plain preference store is right. */
export const STORE_PROMPT_DISMISSED_AT_KEY = 'store-prompt:dismissed-at';

/**
 * How long "Not now" lasts. Long enough that the Home feed is not nagging on
 * every visit, short enough that someone who keeps coming back on a phone is
 * asked again.
 */
export const STORE_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Only the Home card can be dismissed. It is the one a signed-in climber sees
 * on every visit; the other two sit on screens people pass through once.
 */
const DISMISSIBLE_SURFACES: ReadonlySet<StorePromptSurface> = new Set(['home']);

export function isStorePromptSnoozed(dismissedAt: number | null, now: number): boolean {
  if (dismissedAt === null || !Number.isFinite(dismissedAt)) return false;
  return now - dismissedAt < STORE_PROMPT_SNOOZE_MS;
}

function readStorePlatform(): StorePlatform | null {
  return detectStorePlatform(typeof navigator === 'undefined' ? null : navigator.userAgent);
}

export function AppStorePrompt({ surface, style }: AppStorePromptProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const dismissible = DISMISSIBLE_SURFACES.has(surface);
  // Read once: a user agent does not change under a mounted screen.
  const [platform] = useState(readStorePlatform);
  // A dismissible prompt stays hidden until the stored answer is known, so it
  // never flashes in front of someone who already said "Not now".
  const [hidden, setHidden] = useState(dismissible);

  useEffect(() => {
    if (!dismissible || platform === null) return;
    let cancelled = false;
    getPreference<number>(STORE_PROMPT_DISMISSED_AT_KEY)
      .then((dismissedAt) => {
        if (!cancelled) setHidden(isStorePromptSnoozed(dismissedAt, Date.now()));
      })
      // A blocked IndexedDB (private browsing) reads as "never dismissed": the
      // prompt shows, which is the same thing a first visit gets.
      .catch(() => {
        if (!cancelled) setHidden(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dismissible, platform]);

  const handleInstall = useCallback(() => {
    if (platform === null) return;
    track(APP_INSTALL_CLICK_EVENT, buildBrowserAppInstallClickProperties(platform, surface));
    // Opens the store in a new tab, so this page (and the event queued above)
    // outlives the click.
    Linking.openURL(storeUrlForBrowserApp(platform, surface)).catch((error: unknown) => {
      reportError(error, { tags: { source: 'store-prompt', surface } });
    });
  }, [platform, surface]);

  const handleDismiss = useCallback(() => {
    setHidden(true);
    // Best effort: if the write fails the card comes back on the next visit.
    setPreference(STORE_PROMPT_DISMISSED_AT_KEY, Date.now()).catch(() => {});
  }, []);

  if (platform === null || hidden) return null;

  const installLabel = platform === 'android' ? t('mobile.storePrompt.googlePlay') : t('mobile.storePrompt.appStore');

  if (surface === 'home') {
    return (
      <View
        testID="store-prompt-home"
        style={[styles.card, { backgroundColor: systemColors.secondaryBackground }, style]}
      >
        <Text variant="headline">{t('mobile.storePrompt.title')}</Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('mobile.storePrompt.body')}
        </Text>
        <View style={styles.cardActions}>
          <Button
            testID="store-prompt-dismiss"
            title={t('mobile.storePrompt.dismiss')}
            onPress={handleDismiss}
            variant="text"
            size="small"
          />
          <Button
            testID="store-prompt-install"
            title={installLabel}
            onPress={handleInstall}
            variant="filled"
            size="small"
          />
        </View>
      </View>
    );
  }

  if (surface === 'login') {
    return (
      <View testID="store-prompt-login" style={[styles.stack, style]}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered}>
          {t('mobile.storePrompt.body')}
        </Text>
        <Button testID="store-prompt-install" title={installLabel} onPress={handleInstall} variant="tonal" />
      </View>
    );
  }

  // Climb view: one row above the sign-in bar. The board art is why the visitor
  // came, so this takes a single line and the quieter button; signing in stays
  // the filled action underneath.
  return (
    <View testID="store-prompt-climb-view" style={[styles.row, { borderTopColor: systemColors.separator }, style]}>
      <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.rowCopy}>
        {t('mobile.storePrompt.title')}
      </Text>
      <Button testID="store-prompt-install" title={installLabel} onPress={handleInstall} variant="tonal" size="small" />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing[4],
    marginBottom: spacing[3],
    padding: spacing[4],
    borderRadius: borderRadius.lg,
    gap: spacing[2],
  },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[1],
  },
  stack: {
    alignItems: 'center',
    gap: spacing[2],
    marginTop: spacing[5],
  },
  centered: {
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowCopy: {
    flex: 1,
  },
});
