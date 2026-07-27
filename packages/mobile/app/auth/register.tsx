import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { classifyNativeAuthFailureReason } from '../../src/lib/native-auth-analytics';
import { validateRegisterFields, isValid, type RegisterFieldErrors } from '../../src/lib/auth-validation';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useNativeOAuthSignIn } from '../../src/hooks/use-native-oauth-sign-in';
import { AuthFieldset } from '../../src/components/AuthFieldset';
import { Button } from '../../src/components/Button';
import { Text } from '../../src/components/Text';
import { track, setPersonProperties } from '../../src/lib/analytics';
import { webApiUrl } from '../../src/lib/env';
import { reportError } from '../../src/lib/error-reporting';
import { hapticLight } from '../../src/lib/haptics';
import { OAuthProviderButtons, useOAuthProviders } from '../../src/components/auth/OAuthProviderButtons';

type FieldKey = 'name' | 'email' | 'password' | 'confirmPassword';

export default function RegisterScreen() {
  const { register } = useAuth();
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();

  const [values, setValues] = useState({ name: '', email: '', password: '', confirmPassword: '' });
  const [fieldErrors, setFieldErrors] = useState<RegisterFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registrationNextStep, setRegistrationNextStep] = useState<
    'verify_email_sent' | 'verify_email_resend' | 'sign_in' | null
  >(null);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);
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
    const authFlow = Platform.OS === 'web' ? 'web' : 'native';
    track(SHARED_EVENTS.LoginAttempted, { auth_method: 'credentials', flow: authFlow, is_registration: true });
    try {
      const result = await register(trimmedEmail, values.password, values.name.trim() || undefined);
      if (result.success) {
        setPersonProperties(undefined, {
          signup_at: new Date().toISOString(),
          signup_auth_method: 'credentials',
        });

        if (result.authenticated === false) {
          track(SHARED_EVENTS.SignupCompleted, {
            auth_method: 'credentials',
            flow: authFlow,
            requires_verification: result.requiresVerification,
          });
          const verificationEmailNeedsResend =
            Platform.OS === 'web' && result.requiresVerification && 'emailSent' in result && result.emailSent === false;
          setRegistrationNextStep(
            result.requiresVerification
              ? verificationEmailNeedsResend
                ? 'verify_email_resend'
                : 'verify_email_sent'
              : 'sign_in',
          );
          return;
        }

        track(SHARED_EVENTS.LoginSucceeded, {
          auth_method: 'credentials',
          flow: authFlow,
          is_registration: true,
        });
        track(SHARED_EVENTS.SignupCompleted, { auth_method: 'credentials', flow: authFlow });
        // AuthProvider flips isAuthenticated and the auth-group Redirect lands the
        // new user in the app — same auto-login path as signInWithCredentials.
        return;
      }

      const failureReason = classifyNativeAuthFailureReason(result, 'credentials');
      track(SHARED_EVENTS.LoginFailed, {
        auth_method: 'credentials',
        flow: authFlow,
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
          tags: { source: 'native-auth', provider: 'credentials', flow: authFlow, failure_reason: failureReason },
          extra: { status: result.status, server_error: result.error },
        });
        setFormError(t('login.toasts.registrationFailedRetry'));
      }
    } catch (registerError) {
      track(SHARED_EVENTS.LoginFailed, {
        auth_method: 'credentials',
        flow: authFlow,
        failure_reason: 'exception',
        is_registration: true,
      });
      throw registerError;
    } finally {
      setSubmitting(false);
    }
  }

  async function onResendVerification() {
    if (Platform.OS !== 'web' || registrationNextStep !== 'verify_email_resend' || resendingVerification) return;

    setResendError(null);
    setResendingVerification(true);
    try {
      // Cross-origin on the standalone app.boardsesh.com export: a relative
      // URL would hit the static origin (404), so target www via webApiUrl()
      // with included credentials — same pattern as the other auth fetches.
      const response = await fetch(webApiUrl('/api/auth/resend-verification'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      if (!response.ok) {
        setResendError(t('verifyRequest.toasts.failed'));
        return;
      }

      setRegistrationNextStep('verify_email_sent');
    } catch {
      setResendError(t('verifyRequest.toasts.failed'));
    } finally {
      setResendingVerification(false);
    }
  }

  const oauthProviders = useOAuthProviders();
  const showSocialSignIn =
    oauthProviders.loading || oauthProviders.error || oauthProviders.apple || oauthProviders.google;

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
          {registrationNextStep ? (
            <View style={styles.successContainer} accessibilityLiveRegion="polite">
              <Text style={[styles.successText, { color: theme.systemColors.label }]}>
                {registrationNextStep === 'verify_email_sent'
                  ? t('login.toasts.checkEmail')
                  : registrationNextStep === 'verify_email_resend'
                    ? t('login.signUp.verificationEmailNotSent')
                    : t('login.toasts.loginAfterCreate')}
              </Text>
              {registrationNextStep === 'verify_email_resend' ? (
                <>
                  <Button
                    title={t('verifyRequest.resend')}
                    onPress={() => {
                      void onResendVerification();
                    }}
                    variant="filled"
                    size="large"
                    loading={resendingVerification}
                    disabled={resendingVerification}
                  />
                  {resendError ? (
                    <Text variant="footnote" style={styles.errorText} accessibilityLiveRegion="polite">
                      {resendError}
                    </Text>
                  ) : null}
                </>
              ) : null}
              <Button
                title={t('login.submit.signIn')}
                onPress={() => router.replace('/auth/login')}
                variant="text"
                size="large"
              />
            </View>
          ) : (
            <>
              <Text variant="subheadline" color={theme.systemColors.secondaryLabel} style={styles.intro}>
                {t('login.signUp.subtitle')}
              </Text>

              {showSocialSignIn && (
                <>
                  <OAuthProviderButtons
                    disabled={oauthInProgress}
                    isRegistration
                    providers={oauthProviders}
                    onSignIn={(provider) => {
                      hapticLight();
                      void handleOAuthSignIn(provider);
                    }}
                  />

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
                <AuthFieldset
                  onSubmit={() => {
                    void onSubmit();
                  }}
                  fields={[
                    {
                      key: 'email',
                      label: t('login.fields.email'),
                      value: values.email,
                      onChangeText: setField('email'),
                      placeholder: t('login.placeholders.email'),
                      error: fieldErrors.email,
                      keyboardType: 'email-address',
                      autoCapitalize: 'none',
                      autoCorrect: false,
                      // `username` (not emailAddress) lets iOS offer Strong Password + save
                      // the new credential to Keychain on a create-account screen.
                      textContentType: 'username',
                      autoComplete: 'email',
                      editable: !submitting,
                    },
                    {
                      key: 'password',
                      label: t('login.fields.password'),
                      value: values.password,
                      onChangeText: setField('password'),
                      placeholder: t('login.placeholders.password'),
                      error: fieldErrors.password,
                      hint: t('login.signUp.passwordHint'),
                      secureTextEntry: true,
                      autoCapitalize: 'none',
                      autoCorrect: false,
                      textContentType: 'newPassword',
                      autoComplete: 'new-password',
                      editable: !submitting,
                      showLabel: t('login.a11y.showPassword'),
                      hideLabel: t('login.a11y.hidePassword'),
                    },
                    {
                      key: 'confirmPassword',
                      label: t('login.fields.confirmPassword'),
                      value: values.confirmPassword,
                      onChangeText: setField('confirmPassword'),
                      placeholder: t('login.placeholders.confirmPassword'),
                      error: fieldErrors.confirmPassword,
                      secureTextEntry: true,
                      autoCapitalize: 'none',
                      autoCorrect: false,
                      textContentType: 'newPassword',
                      autoComplete: 'new-password',
                      editable: !submitting,
                      showLabel: t('login.a11y.showPassword'),
                      hideLabel: t('login.a11y.hidePassword'),
                    },
                    {
                      key: 'name',
                      label: t('login.fields.name'),
                      value: values.name,
                      onChangeText: setField('name'),
                      placeholder: t('login.placeholders.name'),
                      error: fieldErrors.name,
                      autoCapitalize: 'words',
                      autoCorrect: false,
                      textContentType: 'name',
                      autoComplete: 'name',
                      editable: !submitting,
                    },
                  ]}
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
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'flex-start', padding: 24 },
  intro: { marginBottom: 24 },
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
  successContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 24 },
  successText: { fontSize: 17, textAlign: 'center', lineHeight: 26 },
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
