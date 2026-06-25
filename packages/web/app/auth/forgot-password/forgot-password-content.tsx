'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import MailOutlined from '@mui/icons-material/MailOutlined';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import { EMAIL_REGEX } from '@/app/components/auth/validate-fields';

export default function ForgotPasswordContent() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const { showMessage } = useSnackbar();

  const handleSubmit = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError(t('forgotPassword.validation.emailRequired'));
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError(t('forgotPassword.validation.emailInvalid'));
      return;
    }

    try {
      setLoading(true);
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(data.error || t('forgotPassword.toasts.failed'), 'error');
        return;
      }

      setSubmitted(true);
    } catch (error) {
      console.error('Forgot password error:', error);
      showMessage(t('forgotPassword.toasts.failed'), 'error');
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
          {t('forgotPassword.heading')}
        </Typography>
      </Box>

      <Box component="main" sx={{ padding: '24px', display: 'flex', justifyContent: 'center', paddingTop: '48px' }}>
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent>
            <Stack
              spacing={2}
              component="form"
              onSubmit={(e) => {
                e.preventDefault();
              }}
              noValidate
            >
              {submitted ? (
                <>
                  <Typography variant="body1" component="p">
                    {t('forgotPassword.success')}
                  </Typography>
                  <Button component={LocaleLink} variant="text" href="/auth/login">
                    {t('forgotPassword.back')}
                  </Button>
                </>
              ) : (
                <>
                  <Typography variant="body1" component="p" color="text.secondary">
                    {t('forgotPassword.description')}
                  </Typography>

                  <TextField
                    label={t('forgotPassword.fields.email')}
                    type="email"
                    placeholder={t('login.placeholders.email')}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (emailError) setEmailError(null);
                    }}
                    error={!!emailError}
                    helperText={emailError}
                    required
                    slotProps={{
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <MailOutlined />
                          </InputAdornment>
                        ),
                      },
                    }}
                  />

                  <Button
                    type="submit"
                    variant="contained"
                    onClick={handleSubmit}
                    disabled={loading}
                    startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
                  >
                    {t('forgotPassword.submit')}
                  </Button>

                  <Button component={LocaleLink} variant="text" href="/auth/login">
                    {t('forgotPassword.back')}
                  </Button>
                </>
              )}
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
