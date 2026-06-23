'use client';

import React, { useState } from 'react';
import MuiAlert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MailOutlined from '@mui/icons-material/MailOutlined';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const KNOWN_VERIFY_ERROR_CODES = new Set(['EmailNotVerified', 'InvalidToken', 'TokenExpired', 'TooManyAttempts']);

type EmailErrors = { email?: string };

function validateEmail(email: string, t: TFunction<'auth'>): EmailErrors {
  const errors: EmailErrors = {};
  if (!email) {
    errors.email = t('login.validation.emailRequired');
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = t('login.validation.emailInvalid');
  }
  return errors;
}

export default function VerifyRequestContent() {
  const { t } = useTranslation('auth');
  const searchParams = useSearchParams();
  const error = searchParams.get('error');
  const [resendLoading, setResendLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<EmailErrors>({});
  const { showMessage } = useSnackbar();

  const getErrorMessage = () => {
    if (error && KNOWN_VERIFY_ERROR_CODES.has(error)) {
      return t(`verifyRequest.messages.${error}`);
    }
    return null;
  };

  const handleResend = async () => {
    const validationErrors = validateEmail(email, t);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    try {
      setResendLoading(true);

      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const data = await response.json();

      if (response.ok) {
        showMessage(t('verifyRequest.toasts.sent'), 'success');
      } else {
        showMessage(data.error || t('verifyRequest.toasts.failed'), 'error');
      }
    } catch (err) {
      console.error('Resend error:', err);
    } finally {
      setResendLoading(false);
    }
  };

  const errorMessage = getErrorMessage();

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
          {t('verifyRequest.header')}
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          padding: '24px',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          paddingTop: '48px',
        }}
      >
        <Card sx={{ width: '100%', maxWidth: 400, textAlign: 'center' }}>
          <CardContent>
            <Stack spacing={3} sx={{ width: '100%' }}>
              {errorMessage ? (
                <>
                  <CancelOutlined sx={{ fontSize: 48, color: 'var(--color-error)', mx: 'auto' }} />
                  <MuiAlert severity="error">{errorMessage}</MuiAlert>
                </>
              ) : (
                <>
                  <MailOutlined sx={{ fontSize: 48, color: 'var(--color-primary)', mx: 'auto' }} />
                  <Typography variant="h3">{t('verifyRequest.title')}</Typography>
                  <Typography variant="body1" component="p" color="text.secondary">
                    {t('verifyRequest.description')}
                  </Typography>
                </>
              )}

              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  void handleResend();
                }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <TextField
                  placeholder={t('verifyRequest.resendPlaceholder')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (errors.email) setErrors({});
                  }}
                  error={!!errors.email}
                  helperText={errors.email}
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
                  variant="contained"
                  type="submit"
                  disabled={resendLoading}
                  startIcon={resendLoading ? <CircularProgress size={16} /> : undefined}
                  fullWidth
                  size="large"
                >
                  {t('verifyRequest.resend')}
                </Button>
              </Box>

              <Button variant="text" href="/auth/login">
                {t('verifyRequest.back')}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
