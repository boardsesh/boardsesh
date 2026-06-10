import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { clearPendingOAuthProvider, exchangeTransferToken, getPendingOAuthProvider } from '../../src/lib/auth';
import { classifyNativeAuthFailureReason } from '../../src/lib/native-auth-analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../src/lib/analytics';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';

// Transfer tokens are one-time use, and this screen can mount twice for the
// same token: the callback deep link is routed by expo-router AND the login
// screen routes here explicitly with the callback URL startSignIn resolved.
// Module-level so a remount can't replay (and fail) the exchange — the
// duplicate mount just shows the spinner until AuthProvider redirects.
// Never cleared: one short string per login attempt for the process lifetime
// is negligible, and clearing would reopen the replay window.
const exchangedTokens = new Set<string>();

export default function AuthCallback() {
  const { transferToken } = useLocalSearchParams<{ transferToken: string }>();
  const { t } = useTranslation('auth');
  // Holds a translated, user-facing failure message — never raw server text,
  // which the backend returns in English only.
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const { refreshAuthState } = useAuth();
  const theme = useTheme();

  useEffect(() => {
    // The transfer-token exchange doesn't echo the OAuth provider back, so
    // attribute events to the attempt startSignIn recorded (captured at mount,
    // before any terminal path clears it). Without this, social Login
    // Succeeded events have no auth_method and disappear from every
    // per-method funnel.
    const authMethod = getPendingOAuthProvider() ?? undefined;

    if (!transferToken) {
      // No tracking here: login.tsx owns the no-token outcome — it parses the
      // same callback URL from the browser result and reports the precise
      // reason (session_missing / token_issue_failed / no_transfer_token).
      // This branch can be a second delivery of that URL (expo-router's
      // auto-route) or a stale deep link outside any flow; tracking either
      // would double-count or invent a failed attempt.
      clearPendingOAuthProvider();
      setError(t('callback.noTransferToken'));
      return;
    }

    if (exchangedTokens.has(transferToken)) return;
    exchangedTokens.add(transferToken);

    exchangeTransferToken(transferToken)
      .then(async (result) => {
        if (result.success) {
          track(SHARED_EVENTS.LoginSucceeded, { auth_method: authMethod, flow: 'native' });
          clearPendingOAuthProvider();
          await refreshAuthState();
          router.replace('/(tabs)/climbs');
        } else {
          track(SHARED_EVENTS.LoginFailed, {
            auth_method: authMethod,
            flow: 'native',
            failure_reason: classifyNativeAuthFailureReason(result, 'exchange'),
          });
          clearPendingOAuthProvider();
          // result.error is a raw English/server string; show a translated
          // generic message instead (mirrors login.tsx's networkError pattern).
          setError(t('callback.failed'));
        }
      })
      .catch(() => {
        track(SHARED_EVENTS.LoginFailed, { auth_method: authMethod, flow: 'native', failure_reason: 'exception' });
        clearPendingOAuthProvider();
        setError(t('callback.unexpectedError'));
      });
  }, [transferToken, router, refreshAuthState, t]);

  if (error) {
    return (
      <View style={styles.container}>
        <Text style={[styles.errorText, { color: theme.brandColors.error }]}>{error}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" />
      <Text style={styles.text}>{t('nativeStart.signingIn')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  text: { marginTop: 16, fontSize: 16 },
  errorText: { fontSize: 16, textAlign: 'center' },
});
