import { useState, useSyncExternalStore } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';
import { useTheme } from '../src/providers/theme-provider';
import { useTypographyStyles, type TypographyScale } from '../src/hooks/use-typography-styles';
import { decideAnalyticsConsent } from '../src/providers/consent-provider';
import { Button } from '../src/components/Button';
import { useBlockBack } from '../src/components/onboarding/use-block-back';
import { spacing } from '../src/theme/tokens';
import { WEB_BASE_URL } from '../src/lib/env';
import { track } from '../src/lib/analytics';
import { reportHandledError } from '../src/lib/error-reporting';
import { applyPosthogConsent } from '../src/lib/posthog-client';
import { getConsentSnapshot, subscribeConsent } from '../src/lib/consent-state';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';

function PrivacyConsentScreen() {
  const { t } = useTranslation('consent');
  const { systemColors: colors } = useTheme();
  const styles = useTypographyStyles(createStyles);
  const router = useRouter();
  const navigation = useNavigation();
  const consent = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getConsentSnapshot);
  const [busy, setBusy] = useState(false);
  useBlockBack();
  // This also covers browser history and programmatic navigation. A decision
  // releases the guard synchronously before React has rendered the new choice.
  usePreventRemove(true, ({ data: { action } }) => {
    if (getConsentSnapshot().settled) navigation.dispatch(action);
  });
  const choose = (analytics: 'granted' | 'denied') => {
    if (busy || !getConsentSnapshot().loaded) return;
    setBusy(true);
    // Choice is synchronous; network synchronization never holds the route open.
    void decideAnalyticsConsent(
      analytics,
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    )
      .then(async () => {
        await applyPosthogConsent();
        if (analytics === 'granted') track('Consent Decided', { analytics: 'granted' });
      })
      .catch(reportHandledError);
    if (router.canDismiss()) router.dismiss();
    else router.replace('/');
  };
  return (
    <View style={[styles.backing, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.label }]}>
          {t('mobileTitle')}
        </Text>
        <Text style={[styles.body, { color: colors.secondaryLabel }]}>{t('mobileBody')}</Text>
        <Button
          title={t('allow')}
          onPress={() => choose('granted')}
          disabled={busy || !consent.loaded}
          style={styles.choiceButton}
        />
        <Button
          title={t('deny')}
          onPress={() => choose('denied')}
          disabled={busy || !consent.loaded}
          style={styles.choiceButton}
        />
        <Text
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(`${WEB_BASE_URL}/privacy`).catch(reportHandledError);
          }}
          style={[styles.link, { color: colors.accent }]}
        >
          {t('privacyLink')}
        </Text>
      </View>
    </View>
  );
}

export default holdUntilLaunchReady(PrivacyConsentScreen);

const createStyles = (typography: TypographyScale) =>
  StyleSheet.create({
    backing: { flex: 1, justifyContent: 'center', padding: spacing[6] },
    content: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: spacing[4] },
    choiceButton: { alignSelf: 'stretch' },
    title: { ...typography.title1 },
    body: { ...typography.body },
    link: { ...typography.callout, paddingVertical: spacing[3], textAlign: 'center' },
  });
