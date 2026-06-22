import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextInput as RNTextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { classifyNativeAuthFailureReason } from '../../src/lib/native-auth-analytics';
import { isGoogleSignInConfigured } from '../../src/lib/auth';
import { EMAIL_REGEX } from '../../src/lib/auth-validation';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useNativeOAuthSignIn } from '../../src/hooks/use-native-oauth-sign-in';
import { AuthTextInput } from '../../src/components/AuthTextInput';
import { Button } from '../../src/components/Button';
import { Icon } from '../../src/components/Icon';
import { track } from '../../src/lib/analytics';
import { reportError } from '../../src/lib/error-reporting';
import { hapticLight } from '../../src/lib/haptics';
import { openDiscordInvite } from '../../src/lib/discord';

export default function LoginScreen() {
  const { signInWithCredentials } = useAuth();
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();
  const passwordRef = useRef<RNTextInput>(null);

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
          setError(result.error);
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

  // On some newer Android phones (15+/mandatory edge-to-edge) the login screen can
  // cold-start touch-dead until a configuration change (split-screen) restores it.
  // The underlying fix isn't landed yet, so surface the split-screen workaround as a
  // real recourse for a stuck user. Gated to the affected device class; iOS and older
  // Android never see it.
  const showAndroidFreezeNotice =
    Platform.OS === 'android' && typeof Platform.Version === 'number' && Platform.Version >= 35;

  const isDark = theme.colorScheme === 'dark';

  // Sign in with Apple is iOS-only; Google only when the build shipped its
  // native config (an Apple-only / misconfigured build hides it rather than
  // showing a button that fails on tap). Hide the whole social section if
  // neither is available so the divider doesn't dangle.
  const showAppleSignIn = Platform.OS === 'ios';
  const showGoogleSignIn = isGoogleSignInConfigured();
  const showSocialSignIn = showAppleSignIn || showGoogleSignIn;

  return (
    // SafeAreaView (not a bare View): login has no native header, so without it
    // the form draws under the status/nav bars under Android's mandatory
    // edge-to-edge.
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {showAndroidFreezeNotice ? (
            <View
              style={[
                styles.freezeNotice,
                { backgroundColor: theme.systemColors.secondaryBackground, borderColor: theme.systemColors.separator },
              ]}
              accessibilityRole="alert"
            >
              <Icon name="warning" size={22} color={theme.brandColors.warning} />
              <View style={styles.freezeNoticeText}>
                <Text style={[styles.freezeNoticeTitle, { color: theme.systemColors.label }]}>
                  {t('login.splitScreenNotice.title')}
                </Text>
                <Text style={[styles.freezeNoticeBody, { color: theme.systemColors.secondaryLabel }]}>
                  {t('login.splitScreenNotice.body')}
                </Text>
              </View>
            </View>
          ) : null}
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
            <AuthTextInput
              testID="auth-email-input"
              label={t('login.fields.email')}
              value={email}
              onChangeText={setEmail}
              placeholder={t('login.placeholders.email')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="emailAddress"
              autoComplete="email"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              editable={!submitting}
            />
            <AuthTextInput
              ref={passwordRef}
              testID="auth-password-input"
              label={t('login.fields.password')}
              value={password}
              onChangeText={setPassword}
              placeholder={t('login.placeholders.password')}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              autoComplete="password"
              returnKeyType="done"
              onSubmitEditing={() => {
                void onSubmit();
              }}
              editable={!submitting}
              showLabel={t('login.a11y.showPassword')}
              hideLabel={t('login.a11y.hidePassword')}
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
          </View>

          {showSocialSignIn && (
            <>
              <View style={styles.dividerRow}>
                <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
                <Text style={styles.dividerLabel}>{t('nativeStart.orContinueWith')}</Text>
                <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
              </View>

              <View style={styles.buttons}>
                {showAppleSignIn && (
                  // Apple's official native button — App Review requires it when other
                  // third-party logins are offered. Self-labeled/localized; colour and
                  // corner radius come from the dedicated props (not `style`).
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                    buttonStyle={
                      isDark
                        ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                        : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                    }
                    cornerRadius={12}
                    style={styles.appleButton}
                    onPress={() => {
                      hapticLight();
                      void handleOAuthSignIn('apple');
                    }}
                  />
                )}
                {/* Google's official brand-compliant button — only when the build
                  shipped the Google native config (otherwise it would fail on tap). */}
                {showGoogleSignIn && (
                  <GoogleSigninButton
                    size={GoogleSigninButton.Size.Wide}
                    color={isDark ? GoogleSigninButton.Color.Dark : GoogleSigninButton.Color.Light}
                    disabled={oauthInProgress}
                    style={styles.googleButton}
                    onPress={() => {
                      hapticLight();
                      void handleOAuthSignIn('google');
                    }}
                  />
                )}
              </View>
            </>
          )}

          <View style={styles.footer}>
            <Text style={[styles.footerText, { color: theme.systemColors.secondaryLabel }]}>
              {t('login.links.noAccount')}{' '}
            </Text>
            <Pressable
              onPress={() => {
                hapticLight();
                router.push('/auth/register');
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  freezeNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
  },
  freezeNoticeText: {
    flex: 1,
    gap: 4,
  },
  freezeNoticeTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  freezeNoticeBody: {
    fontSize: 14,
    lineHeight: 19,
  },
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
  buttons: { gap: 12 },
  // Apple's native button needs explicit height + width or it renders nothing.
  appleButton: { width: '100%', height: 50 },
  googleButton: { width: '100%', height: 50 },
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
