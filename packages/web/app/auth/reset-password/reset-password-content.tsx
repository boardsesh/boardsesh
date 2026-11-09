'use client';

import { useState, useId } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import LockOutlined from '@mui/icons-material/LockOutlined';
import Button from '@mui/material/Button';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@/app/components/auth/validate-fields';
import { themeTokens } from '@/app/theme/theme-config';
import { FormShell, FormField, FormActions, focusFirstInvalidAfterRender } from '@/app/components/form';
import { isAuthBackendUnavailable } from '@boardsesh/auth-protocol/client-errors';

export default function ResetPasswordContent() {
  const { t } = useTranslation('auth');
  const searchParams = useSearchParams();
  const router = useRouter();
  const { showMessage } = useSnackbar();

  const token = searchParams.get('token') || '';
  const email = searchParams.get('email') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isLinkInvalid = !token || !email;
  const formId = useId();

  const handleSubmit = async () => {
    setFormError(null);
    if (!password) {
      setPasswordError(t('resetPassword.validation.passwordRequired'));
      focusFirstInvalidAfterRender(formId);
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(t('resetPassword.validation.passwordTooShort'));
      focusFirstInvalidAfterRender(formId);
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      setPasswordError(t('resetPassword.validation.passwordTooLong'));
      focusFirstInvalidAfterRender(formId);
      return;
    }
    if (!confirmPassword) {
      setConfirmPasswordError(t('resetPassword.validation.confirmPasswordRequired'));
      focusFirstInvalidAfterRender(formId);
      return;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t('resetPassword.validation.passwordsMismatch'));
      focusFirstInvalidAfterRender(formId);
      return;
    }

    try {
      setLoading(true);
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password, confirmPassword }),
      });

      const data = await response.json();
      if (!response.ok) {
        setFormError(
          isAuthBackendUnavailable(data.error)
            ? t('login.toasts.authFailed')
            : data.error || t('resetPassword.toasts.failed'),
        );
        return;
      }

      showMessage(t('resetPassword.toasts.success'), 'success');
      router.replace('/auth/login');
    } catch (error) {
      console.error('Reset password error:', error);
      setFormError(t('resetPassword.toasts.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', background: 'var(--semantic-background)' }}>
      <Box
        component="header"
        sx={{
          background: 'var(--semantic-surface)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          boxShadow: themeTokens.shadows.xs,
          height: 64,
        }}
      >
        <BackButton />
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('resetPassword.heading')}
        </Typography>
      </Box>

      <Box component="main" sx={{ padding: '24px', display: 'flex', justifyContent: 'center', paddingTop: '48px' }}>
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent>
            {isLinkInvalid ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="body1" color="error">
                  {t('resetPassword.invalidLink')}
                </Typography>
                <Button component={LocaleLink} variant="text" href="/auth/login">
                  {t('resetPassword.back')}
                </Button>
              </Box>
            ) : (
              <FormShell
                id={formId}
                maxWidth={false}
                error={formError}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSubmit();
                }}
              >
                <Typography variant="body1" component="p" color="text.secondary">
                  {t('resetPassword.description', { email })}
                </Typography>

                <FormField label={t('resetPassword.fields.newPassword')} error={passwordError}>
                  {(field) => (
                    <TextField
                      id={field.id}
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        if (passwordError) setPasswordError(null);
                      }}
                      fullWidth
                      error={Boolean(field.error)}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <LockOutlined />
                            </InputAdornment>
                          ),
                        },
                        htmlInput: { 'aria-describedby': field.describedBy },
                      }}
                    />
                  )}
                </FormField>

                <FormField label={t('resetPassword.fields.confirmPassword')} error={confirmPasswordError}>
                  {(field) => (
                    <TextField
                      id={field.id}
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                        if (confirmPasswordError) setConfirmPasswordError(null);
                      }}
                      fullWidth
                      error={Boolean(field.error)}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <LockOutlined />
                            </InputAdornment>
                          ),
                        },
                        htmlInput: { 'aria-describedby': field.describedBy },
                      }}
                    />
                  )}
                </FormField>

                <FormActions submitLabel={t('resetPassword.submit')} submitting={loading} layout="stacked" />

                <Button component={LocaleLink} variant="text" href="/auth/login">
                  {t('resetPassword.back')}
                </Button>
              </FormShell>
            )}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
