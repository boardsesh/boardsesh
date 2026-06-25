import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { EMAIL_REGEX } from '../../src/lib/auth-validation';
import { requestPasswordReset } from '../../src/lib/auth';
import { iosSystemColors } from '../../src/theme/ios-colors';
import { useTheme } from '../../src/providers/theme-provider';
import { AuthTextInput } from '../../src/components/AuthTextInput';
import { Button } from '../../src/components/Button';
import { hapticLight } from '../../src/lib/haptics';
import { reportError } from '../../src/lib/error-reporting';
import { track } from '../../src/lib/analytics';

export default function ForgotPasswordScreen() {
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const trimmedEmail = email.trim();
  const canSubmit = !submitting && trimmedEmail.length > 0;

  async function onSubmit() {
    if (!canSubmit) return;

    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError(t('forgotPassword.validation.emailInvalid'));
      return;
    }

    setEmailError(null);
    setFormError(null);
    setSubmitting(true);
    hapticLight();
    track('Forgot Password Requested', { flow: 'native' });

    try {
      const result = await requestPasswordReset(trimmedEmail);
      if (!result.success) {
        if (result.error === 'network') {
          setFormError(t('nativeStart.networkError'));
        } else {
          reportError(new Error(`Forgot password failed: ${result.error}`), {
            tags: { source: 'native-auth', flow: 'forgot-password' },
            extra: { status: result.status, server_error: result.error },
          });
          setFormError(t('forgotPassword.toasts.failed'));
        }
        return;
      }
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: t('forgotPassword.heading') }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {submitted ? (
            <View style={styles.successContainer}>
              <Text style={[styles.successText, { color: theme.systemColors.label }]}>
                {t('forgotPassword.toasts.success')}
              </Text>
              <Button
                title={t('forgotPassword.back')}
                onPress={() => router.replace('/auth/login')}
                variant="text"
                size="large"
              />
            </View>
          ) : (
            <>
              <Text style={[styles.description, { color: theme.systemColors.secondaryLabel }]}>
                {t('forgotPassword.description')}
              </Text>

              <View style={styles.form}>
                <AuthTextInput
                  label={t('forgotPassword.fields.email')}
                  value={email}
                  onChangeText={(text) => {
                    setEmail(text);
                    if (emailError) setEmailError(null);
                  }}
                  placeholder={t('login.placeholders.email')}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="emailAddress"
                  autoComplete="email"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    void onSubmit();
                  }}
                  editable={!submitting}
                  error={emailError ?? undefined}
                />

                {formError ? (
                  <Text style={styles.errorText} accessibilityLiveRegion="polite">
                    {formError}
                  </Text>
                ) : null}

                <Button
                  title={t('forgotPassword.submit')}
                  onPress={() => {
                    void onSubmit();
                  }}
                  variant="filled"
                  size="large"
                  loading={submitting}
                  disabled={!canSubmit}
                  style={styles.submitButton}
                />
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 24, paddingTop: 16 },
  description: { fontSize: 15, lineHeight: 22, marginBottom: 24 },
  form: { gap: 12 },
  submitButton: { alignSelf: 'stretch', marginTop: 4 },
  errorText: { color: iosSystemColors.systemRed, fontSize: 15 },
  successContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  successText: { fontSize: 17, textAlign: 'center', lineHeight: 26 },
});
