import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { classifyNativeAuthFailureReason } from '../../src/lib/native-auth-analytics';
import { EMAIL_REGEX } from '../../src/lib/auth-validation';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useNativeOAuthSignIn } from '../../src/hooks/use-native-oauth-sign-in';
import { AuthFieldset } from '../../src/components/AuthFieldset';
import { Button } from '../../src/components/Button';
import { track } from '../../src/lib/analytics';
import { reportError } from '../../src/lib/error-reporting';
import { hapticLight } from '../../src/lib/haptics';
import { openDiscordInvite } from '../../src/lib/discord';
import { OAuthProviderButtons, useOAuthProviders } from '../../src/components/auth/OAuthProviderButtons';
import { readPostLoginReturnHref } from '../../src/lib/routing/anonymous-auth-gate';

export default function LoginScreen() {
  const { signInWithCredentials } = useAuth();
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();
  // Web only: the climb a signed-out visitor arrived for, carried here as
  // `?next=`. This screen deliberately never navigates with it — AuthProvider's
  // `isAuthenticated && inAuthGroup` redirect reads the same value off the
  // location in the same commit, and a `router.replace` here would race it. The
  // one thing it owns is the sign-up hop, so someone who registers instead of
  // signing in comes back to the same climb. Constant `null` on native, which
  // keeps the call below literally `router.push('/auth/register')` there.
  const returnHref = readPostLoginReturnHref();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Shared Apple/Google flow; errors land in the same region as credentials sign-in.
  const { signIn: handleOAuthSignIn, inProgress: oauthInProgress } = useNativeOAuthSignIn({ setError });

  const trimmedEmail = email.trim();
  const canSubmit = !submitting && trimmedEmail.length > 0 && password.length > 0;

  async function onSubmit() {
    if (!canSubmit) return;

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError(t('login.validation.emailInvalid'));
      return;
    }

    setError(null);
    setSubmitting(true);
    track(SHARED_EVENTS.LoginAttempted, { auth_method: 'credentials', flow: 'native' });
    try {
      const result = await signInWithCredentials(trimmedEmail, password);
      if (!result.success) {
        const credentialsFailureReason = classifyNativeAuthFailureReason(result, 'credentials');
        track(SHARED_EVENTS.LoginFailed, {
          auth_method: 'credentials',
          failure_reason: credentialsFailureReason,
          failure_detail: result.error,
        });
        if (result.error === 'network') {
          setError(t('nativeStart.networkError'));
        } else if (result.status === 401) {
          // Wrong email/password is a normal user error, not telemetry-worthy.
          setError(t('login.toasts.invalidCredentials'));
        } else if (result.status === 429) {
          // The shared native-auth rate limiter did its job. Expected on a gym's
          // shared IP, so it is not telemetry-worthy either — and the backend's
          // own message is untranslated English we should not put on screen.
          setError(t('login.toasts.tooManyAttempts'));
        } else {
          // An unexpected backend failure (5xx, malformed response, …) — report
          // it so a broken credentials endpoint is visible, not just a red toast.
          reportError(new Error(`Credentials sign-in failed: ${result.error}`), {
            tags: {
              source: 'native-auth',
              provider: 'credentials',
              flow: 'native',
              failure_reason: credentialsFailureReason,
            },
            extra: { status: result.status, server_error: result.error },
          });
          // Not `result.error`: on a non-JSON body that is the literal string
          // `HTTP <status>` (auth.ts), so a gateway 504 rendered "HTTP 504" in
          // the form — untranslated, and meaningless to a climber. The raw value
          // still rides along to Sentry above as `server_error`.
          setError(t('login.toasts.authFailed'));
        }
      } else {
        track(SHARED_EVENTS.LoginSucceeded, { auth_method: 'credentials', flow: 'native' });
      }
      // On success, AuthProvider flips isAuthenticated and the redirect handles navigation.
    } catch (signInError) {
      track(SHARED_EVENTS.LoginFailed, {
        auth_method: 'credentials',
        failure_reason: 'exception',
      });
      throw signInError;
    } finally {
      setSubmitting(false);
    }
  }

  const oauthProviders = useOAuthProviders();
  const showSocialSignIn =
    oauthProviders.loading || oauthProviders.error || oauthProviders.apple || oauthProviders.google;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.header}>
          <Image
            source={require('../../assets/splash-icon.png')}
            style={styles.logo}
            contentFit="contain"
            accessible={false}
          />
          <Text style={[styles.title, { color: theme.brandColors.primary }]}>Boardsesh</Text>
          <Text style={[styles.subtitle, { color: theme.systemColors.secondaryLabel }]}>
            {t('nativeStart.tagline')}
          </Text>
        </View>

        <View style={styles.form}>
          <AuthFieldset
            onSubmit={() => {
              void onSubmit();
            }}
            fields={[
              {
                key: 'email',
                testID: 'auth-email-input',
                label: t('login.fields.email'),
                value: email,
                onChangeText: setEmail,
                placeholder: t('login.placeholders.email'),
                keyboardType: 'email-address',
                autoCapitalize: 'none',
                autoCorrect: false,
                textContentType: 'emailAddress',
                autoComplete: 'email',
                editable: !submitting,
              },
              {
                key: 'password',
                testID: 'auth-password-input',
                label: t('login.fields.password'),
                value: password,
                onChangeText: setPassword,
                placeholder: t('login.placeholders.password'),
                secureTextEntry: true,
                autoCapitalize: 'none',
                autoCorrect: false,
                textContentType: 'password',
                autoComplete: 'password',
                editable: !submitting,
                showLabel: t('login.a11y.showPassword'),
                hideLabel: t('login.a11y.hidePassword'),
              },
            ]}
          />
          <Button
            testID="auth-submit-button"
            title={t('nativeStart.signIn')}
            onPress={() => {
              void onSubmit();
            }}
            variant="filled"
            size="large"
            loading={submitting}
            disabled={!canSubmit}
            style={styles.submitButton}
          />
          {error ? (
            <Text style={styles.errorText} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          <Pressable
            onPress={() => {
              hapticLight();
              router.push('/auth/forgot-password');
            }}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={styles.forgotPasswordHit}
            accessibilityRole="link"
          >
            <Text style={[styles.forgotPasswordLink, { color: theme.systemColors.secondaryLabel }]}>
              {t('login.links.forgotPassword')}
            </Text>
          </Pressable>
        </View>

        {showSocialSignIn && (
          <>
            <View style={styles.dividerRow}>
              <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
              <Text style={styles.dividerLabel}>{t('nativeStart.orContinueWith')}</Text>
              <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
            </View>

            <OAuthProviderButtons
              disabled={oauthInProgress}
              isRegistration={false}
              providers={oauthProviders}
              onSignIn={(provider) => {
                hapticLight();
                void handleOAuthSignIn(provider);
              }}
            />
          </>
        )}

        <View style={styles.footer}>
          <Text style={[styles.footerText, { color: theme.systemColors.secondaryLabel }]}>
            {t('login.links.noAccount')}{' '}
          </Text>
          <Pressable
            onPress={() => {
              hapticLight();
              router.push(returnHref ? { pathname: '/auth/register', params: { next: returnHref } } : '/auth/register');
            }}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={styles.footerLinkHit}
            accessibilityRole="link"
          >
            <Text style={[styles.footerLink, { color: theme.systemColors.accent }]}>{t('login.submit.signUp')}</Text>
          </Pressable>
        </View>

        {/* Last-resort help for someone stuck at the gate: opens our Discord in the
            browser. Sheet-free on purpose so nothing can block the login screen. */}
        <View style={styles.troubleRow}>
          <Text style={[styles.footerText, { color: theme.systemColors.secondaryLabel }]}>
            {t('login.links.troubleSigningIn')}{' '}
          </Text>
          <Pressable
            onPress={() => {
              hapticLight();
              void openDiscordInvite('login');
            }}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={styles.footerLinkHit}
            accessibilityRole="link"
          >
            <Text style={[styles.footerLink, { color: theme.systemColors.accent }]}>{t('login.links.discord')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  logo: { width: 96, height: 96, marginBottom: 16 },
  title: { fontSize: 34, fontWeight: '700', marginBottom: 8 },
  subtitle: { fontSize: 17 },
  form: { gap: 12 },
  submitButton: { alignSelf: 'stretch', marginTop: 4 },
  errorText: {
    color: '#FF3B30',
    fontSize: 15,
    marginTop: 4,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 24,
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerLabel: {
    fontSize: 13,
    opacity: 0.6,
  },
  forgotPasswordHit: {
    alignSelf: 'center',
    marginTop: 4,
    minHeight: 44,
    justifyContent: 'center',
  },
  forgotPasswordLink: {
    fontSize: 15,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
  },
  troubleRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
  },
  footerText: { fontSize: 15 },
  footerLink: { fontSize: 15, fontWeight: '600' },
  // Keeps the tappable area at the 44pt/48dp minimum.
  footerLinkHit: { minHeight: 44, justifyContent: 'center' },
});
