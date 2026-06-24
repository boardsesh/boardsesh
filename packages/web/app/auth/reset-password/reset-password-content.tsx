'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import LockOutlined from '@mui/icons-material/LockOutlined';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { PASSWORD_MIN_LENGTH } from '@/app/components/auth/validate-fields';
import { themeTokens } from '@/app/theme/theme-config';

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
  const [loading, setLoading] = useState(false);

  const isLinkInvalid = !token || !email;

  const handleSubmit = async () => {
    if (!password) {
      setPasswordError(t('resetPassword.validation.passwordRequired'));
      return;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(t('resetPassword.validation.passwordTooShort'));
      return;
    }
    if (!confirmPassword) {
      setConfirmPasswordError(t('resetPassword.validation.confirmPasswordRequired'));
      return;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t('resetPassword.validation.passwordsMismatch'));
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
        showMessage(data.error || t('resetPassword.toasts.failed'), 'error');
        return;
      }

      showMessage(t('resetPassword.toasts.success'), 'success');
      router.push('/auth/login');
    } catch (error) {
      console.error('Reset password error:', error);
      showMessage(t('resetPassword.toasts.failed'), 'error');
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
            <Stack spacing={2}>
              {isLinkInvalid ? (
                <Typography variant="body1" color="error">
                  {t('resetPassword.invalidLink')}
                </Typography>
              ) : (
                <>
                  <Typography variant="body1" component="p" color="text.secondary">
                    {t('resetPassword.description', { email })}
                  </Typography>

                  <TextField
                    label={t('resetPassword.fields.newPassword')}
                    type="password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (passwordError) setPasswordError(null);
                    }}
                    error={!!passwordError}
                    helperText={passwordError}
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <LockOutlined />
                          </InputAdornment>
                        ),
                      },
                    }}
                  />

                  <TextField
                    label={t('resetPassword.fields.confirmPassword')}
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (confirmPasswordError) setConfirmPasswordError(null);
                    }}
                    error={!!confirmPasswordError}
                    helperText={confirmPasswordError}
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <LockOutlined />
                          </InputAdornment>
                        ),
                      },
                    }}
                  />

                  <Button
                    variant="contained"
                    onClick={handleSubmit}
                    disabled={loading}
                    startIcon={loading ? <CircularProgress size={16} /> : undefined}
                  >
                    {t('resetPassword.submit')}
                  </Button>
                </>
              )}

              <Button component={LocaleLink} variant="text" href="/auth/login">
                {t('resetPassword.back')}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
