import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextInput as RNTextInput,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { PASSWORD_MIN_LENGTH } from '../../src/lib/auth-validation';
import { resetPassword } from '../../src/lib/auth';
import { useTheme } from '../../src/providers/theme-provider';
import { AuthTextInput } from '../../src/components/AuthTextInput';
import { Button } from '../../src/components/Button';
import { hapticLight } from '../../src/lib/haptics';
import { reportError } from '../../src/lib/error-reporting';
import { track } from '../../src/lib/analytics';

export default function ResetPasswordScreen() {
  const { t } = useTranslation('auth');
  const theme = useTheme();
  const router = useRouter();
  const confirmRef = useRef<RNTextInput>(null);

  const { token, email } = useLocalSearchParams<{ token?: string; email?: string }>();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLinkInvalid = !token || !email;
  const canSubmit = !submitting && password.length > 0 && confirmPassword.length > 0;

  async function onSubmit() {
    if (!canSubmit || isLinkInvalid) return;

    let hasError = false;
    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(t('resetPassword.validation.passwordTooShort'));
      hasError = true;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t('resetPassword.validation.passwordsMismatch'));
      hasError = true;
    }
    if (hasError) return;

    setPasswordError(null);
    setConfirmPasswordError(null);
    setFormError(null);
    setSubmitting(true);
    hapticLight();
    track('Password Reset Submitted', { flow: 'native' });

    try {
      const result = await resetPassword(email, token, password);
      if (!result.success) {
        if (result.error === 'network') {
          setFormError(t('nativeStart.networkError'));
        } else if (result.status === 400) {
          setFormError(t('resetPassword.toasts.failed'));
        } else {
          reportError(new Error(`Reset password failed: ${result.error}`), {
            tags: { source: 'native-auth', flow: 'reset-password' },
            extra: { status: result.status, server_error: result.error },
          });
          setFormError(t('resetPassword.toasts.failed'));
        }
        return;
      }
      track('Password Reset Succeeded', { flow: 'native' });
      router.replace('/auth/login');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: t('resetPassword.heading') }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          {isLinkInvalid ? (
            <View style={styles.errorContainer}>
              <Text style={[styles.invalidLinkText, { color: theme.systemColors.label }]}>
                {t('resetPassword.invalidLink')}
              </Text>
            </View>
          ) : (
            <>
              <Text style={[styles.description, { color: theme.systemColors.secondaryLabel }]}>
                {t('resetPassword.description', { email })}
              </Text>

              <View style={styles.form}>
                <AuthTextInput
                  label={t('resetPassword.fields.newPassword')}
                  value={password}
                  onChangeText={(text) => {
                    setPassword(text);
                    if (passwordError) setPasswordError(null);
                  }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  autoComplete="new-password"
                  returnKeyType="next"
                  onSubmitEditing={() => confirmRef.current?.focus()}
                  editable={!submitting}
                  error={passwordError ?? undefined}
                  showLabel={t('login.a11y.showPassword')}
                  hideLabel={t('login.a11y.hidePassword')}
                />

                <AuthTextInput
                  ref={confirmRef}
                  label={t('resetPassword.fields.confirmPassword')}
                  value={confirmPassword}
                  onChangeText={(text) => {
                    setConfirmPassword(text);
                    if (confirmPasswordError) setConfirmPasswordError(null);
                  }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  autoComplete="new-password"
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    void onSubmit();
                  }}
                  editable={!submitting}
                  error={confirmPasswordError ?? undefined}
                  showLabel={t('login.a11y.showPassword')}
                  hideLabel={t('login.a11y.hidePassword')}
                />

                {formError ? (
                  <Text style={styles.errorText} accessibilityLiveRegion="polite">
                    {formError}
                  </Text>
                ) : null}

                <Button
                  title={t('resetPassword.submit')}
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
  errorText: { color: '#FF3B30', fontSize: 15 },
  errorContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  invalidLinkText: { fontSize: 17, textAlign: 'center', lineHeight: 26 },
});
