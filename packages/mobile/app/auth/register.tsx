import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type TextInput as RNTextInput,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSigninButton } from '@react-native-google-signin/google-signin';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { classifyNativeAuthFailureReason } from '../../src/lib/native-auth-analytics';
import { isGoogleSignInConfigured } from '../../src/lib/auth';
import { validateRegisterFields, isValid, type RegisterFieldErrors } from '../../src/lib/auth-validation';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useNativeOAuthSignIn } from '../../src/hooks/use-native-oauth-sign-in';
import { AuthTextInput } from '../../src/components/AuthTextInput';
import { Button } from '../../src/components/Button';
import { Text } from '../../src/components/Text';
import { track } from '../../src/lib/analytics';
import { reportError } from '../../src/lib/error-reporting';
import { hapticLight } from '../../src/lib/haptics';

type FieldKey = 'name' | 'email' | 'password' | 'confirmPassword';

export default function RegisterScreen() {
  const { register } = useAuth();
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();
  const passwordRef = useRef<RNTextInput>(null);
  const confirmRef = useRef<RNTextInput>(null);
  const nameRef = useRef<RNTextInput>(null);

  const [values, setValues] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Shared Apple/Google flow; OAuth errors land in the same region as the form.
  const { signIn: handleOAuthSignIn, inProgress: oauthInProgress } = useNativeOAuthSignIn({
    isRegistration: true,
    setError: setFormError,
  });

  // Editing a field clears its inline error so a fixed field stops shouting.
  const setField = (key: FieldKey) => (text: string) => {
    setValues((prev) => ({ ...prev, [key]: text }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const trimmedEmail = values.email.trim();
  const canSubmit =
    !submitting && trimmedEmail.length > 0 && values.password.length > 0 && values.confirmPassword.length > 0;

  async function onSubmit() {
    if (!canSubmit) return;

    const errorKeys = validateRegisterFields(values);
    if (!isValid(errorKeys)) {
      // Map the validator's i18n keys to translated, per-field messages. The
      // keys come from validateRegisterFields, so translate via a static switch
      // (not `t(variable)`, which the i18n orphan-checker can't analyse and which
      // would leave these keys looking unreferenced). Every key it can return is
      // a string-literal t() call below, so all stay statically discoverable.
      const translateValidationKey = (key: string | undefined): string | undefined => {
        switch (key) {
          case 'login.validation.nameTooLong':
            return t('login.validation.nameTooLong');
          case 'login.validation.emailRequired':
            return t('login.validation.emailRequired');
          case 'login.validation.emailInvalid':
            return t('login.validation.emailInvalid');
          case 'login.validation.passwordRequired':
            return t('login.validation.passwordRequired');
          case 'login.validation.passwordRequiredCreate':
            return t('login.validation.passwordRequiredCreate');
          case 'login.validation.passwordTooShort':
            return t('login.validation.passwordTooShort');
          case 'login.validation.passwordTooLong':
            return t('login.validation.passwordTooLong');
          case 'login.validation.passwordsMismatch':
            return t('login.validation.passwordsMismatch');
          case 'login.validation.confirmPasswordRequired':
            return t('login.validation.confirmPasswordRequired');
          default:
            return undefined;
        }
      };
      setFieldErrors({
        name: translateValidationKey(errorKeys.name),
        email: translateValidationKey(errorKeys.email),
        password: translateValidationKey(errorKeys.password),
        confirmPassword: translateValidationKey(errorKeys.confirmPassword),
      });
      return;
    }

    setFieldErrors({});
    setFormError(null);
    setSubmitting(true);
    track(SHARED_EVENTS.LoginAttempted, { auth_method: 'credentials', flow: 'native', is_registration: true });
    try {
      const result = await register(trimmedEmail, values.password, values.name.trim() || undefined);
      if (result.success) {
        track(SHARED_EVENTS.LoginSucceeded, { auth_method: 'credentials', flow: 'native', is_registration: true });
        // AuthProvider flips isAuthenticated and the auth-group Redirect lands the
        // new user in the app — same auto-login path as signInWithCredentials.
        return;
      }

      const failureReason = classifyNativeAuthFailureReason(result, 'credentials');
      track(SHARED_EVENTS.LoginFailed, {
        auth_method: 'credentials',
        flow: 'native',
        failure_reason: failureReason,
        failure_detail: result.error,
        is_registration: true,
      });
      if (result.error === 'network') {
        setFormError(t('nativeStart.networkError'));
      } else if (result.status === 409) {
        // Email already has an account — a normal case, not telemetry-worthy.
        // Point them at the email field and the "Sign in" footer link.
        setFieldErrors({ email: t('login.toasts.accountExists') });
      } else if (result.status === 400) {
        // Client validation should have caught this; surface the server message.
        setFormError(result.error);
      } else {
        // An unexpected backend failure (5xx, malformed response, …) — report it
        // so a broken register endpoint is visible, not just a red line.
        reportError(new Error(`Registration failed: ${result.error}`), {
          tags: { source: 'native-auth', provider: 'credentials', flow: 'native', failure_reason: failureReason },
          extra: { status: result.status, server_error: result.error },
        });
        setFormError(t('login.toasts.registrationFailedRetry'));
      }
    } catch (registerError) {
      track(SHARED_EVENTS.LoginFailed, {
        auth_method: 'credentials',
        flow: 'native',
        failure_reason: 'exception',
        is_registration: true,
      });
      throw registerError;
    } finally {
      setSubmitting(false);
    }
  }

  const isDark = theme.colorScheme === 'dark';
  const showAppleSignIn = Platform.OS === 'ios';
  const showGoogleSignIn = isGoogleSignInConfigured();
  const showSocialSignIn = showAppleSignIn || showGoogleSignIn;

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: t('login.tabs.signUp') }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          // The stack header is transparent + blurred on iOS; inset the form
          // below it (and the status bar) instead of drawing under it.
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <Text variant="subheadline" color={theme.systemColors.secondaryLabel} style={styles.intro}>
            {t('login.signUp.subtitle')}
          </Text>

          {showSocialSignIn && (
            <>
              <View style={styles.socialButtons}>
                {showAppleSignIn && (
                  // SIGN_UP variant on the registration screen, per Apple HIG.
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP}
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

              <View style={styles.dividerRow}>
                <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
                <Text variant="footnote" color={theme.systemColors.secondaryLabel}>
                  {t('login.divider')}
                </Text>
                <View style={[styles.dividerLine, { backgroundColor: theme.systemColors.separator }]} />
              </View>
            </>
          )}

          <View style={styles.form}>
            <AuthTextInput
              label={t('login.fields.email')}
              value={values.email}
              onChangeText={setField('email')}
              placeholder={t('login.placeholders.email')}
              error={fieldErrors.email}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              // `username` (not emailAddress) lets iOS offer Strong Password + save
              // the new credential to Keychain on a create-account screen.
              textContentType="username"
              autoComplete="email"
              returnKeyType="next"
              onSubmitEditing={() => passwordRef.current?.focus()}
              editable={!submitting}
            />
            <AuthTextInput
              ref={passwordRef}
              label={t('login.fields.password')}
              value={values.password}
              onChangeText={setField('password')}
              placeholder={t('login.placeholders.password')}
              error={fieldErrors.password}
              hint={t('login.signUp.passwordHint')}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              autoComplete="new-password"
              passwordRules="minlength: 8; maxlength: 128;"
              returnKeyType="next"
              onSubmitEditing={() => confirmRef.current?.focus()}
              editable={!submitting}
              showLabel={t('login.a11y.showPassword')}
              hideLabel={t('login.a11y.hidePassword')}
            />
            <AuthTextInput
              ref={confirmRef}
              label={t('login.fields.confirmPassword')}
              value={values.confirmPassword}
              onChangeText={setField('confirmPassword')}
              placeholder={t('login.placeholders.confirmPassword')}
              error={fieldErrors.confirmPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="newPassword"
              autoComplete="new-password"
              returnKeyType="next"
              onSubmitEditing={() => nameRef.current?.focus()}
              editable={!submitting}
              showLabel={t('login.a11y.showPassword')}
              hideLabel={t('login.a11y.hidePassword')}
            />
            <AuthTextInput
              ref={nameRef}
              label={t('login.fields.name')}
              value={values.name}
              onChangeText={setField('name')}
              placeholder={t('login.placeholders.name')}
              error={fieldErrors.name}
              autoCapitalize="words"
              autoCorrect={false}
              textContentType="name"
              autoComplete="name"
              returnKeyType="done"
              onSubmitEditing={() => {
                void onSubmit();
              }}
              editable={!submitting}
            />
            <Button
              title={t('login.submit.signUp')}
              onPress={() => {
                void onSubmit();
              }}
              variant="filled"
              size="large"
              loading={submitting}
              disabled={!canSubmit}
              style={styles.submitButton}
            />
            {formError ? (
              <Text variant="footnote" style={styles.errorText} accessibilityLiveRegion="polite">
                {formError}
              </Text>
            ) : null}
          </View>

          <View style={styles.footer}>
            <Text variant="subheadline" color={theme.systemColors.secondaryLabel}>
              {t('login.links.haveAccount')}{' '}
            </Text>
            {/* replace (not back) so a deep-link straight to /auth/register still
                lands on login rather than no-op'ing on an empty back stack. */}
            <Pressable
              onPress={() => router.replace('/auth/login')}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={styles.footerLinkHit}
              accessibilityRole="link"
            >
              <Text variant="subheadline" color={theme.systemColors.accent} style={styles.footerLink}>
                {t('login.submit.signIn')}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'flex-start', padding: 24 },
  intro: { marginBottom: 24 },
  socialButtons: { gap: 12 },
  // Apple's native button needs explicit height + width or it renders nothing.
  appleButton: { width: '100%', height: 50 },
  googleButton: { width: '100%', height: 50 },
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
  form: { gap: 12 },
  submitButton: { alignSelf: 'stretch', marginTop: 4 },
  errorText: { color: '#FF3B30', marginTop: 4 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 24,
  },
  footerLink: { fontWeight: '600' },
  // Keeps the tappable area at the 44pt/48dp minimum.
  footerLinkHit: { minHeight: 44, justifyContent: 'center' },
});
