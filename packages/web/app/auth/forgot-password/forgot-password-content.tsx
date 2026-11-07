'use client';

import { useState, useId } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import MailOutlined from '@mui/icons-material/MailOutlined';
import Button from '@mui/material/Button';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import { EMAIL_REGEX } from '@/app/components/auth/validate-fields';
import { FormShell, FormField, FormActions, focusFirstInvalidAfterRender } from '@/app/components/form';
import { isAuthBackendUnavailable } from '@boardsesh/auth-protocol/client-errors';

export default function ForgotPasswordContent() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const formId = useId();

  const handleSubmit = async () => {
    setFormError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError(t('forgotPassword.validation.emailRequired'));
      focusFirstInvalidAfterRender(formId);
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setEmailError(t('forgotPassword.validation.emailInvalid'));
      focusFirstInvalidAfterRender(formId);
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
        setFormError(
          isAuthBackendUnavailable(data.error)
            ? t('login.toasts.authFailed')
            : data.error || t('forgotPassword.toasts.failed'),
        );
        return;
      }

      setSubmitted(true);
    } catch (error) {
      console.error('Forgot password error:', error);
      setFormError(t('forgotPassword.toasts.failed'));
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
            {submitted ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="body1" component="p">
                  {t('forgotPassword.success')}
                </Typography>
                <Button component={LocaleLink} variant="text" href="/auth/login">
                  {t('forgotPassword.back')}
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
                  {t('forgotPassword.description')}
                </Typography>

                <FormField label={t('forgotPassword.fields.email')} required error={emailError}>
                  {(field) => (
                    <TextField
                      id={field.id}
                      type="email"
                      autoComplete="email"
                      placeholder={t('login.placeholders.email')}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (emailError) setEmailError(null);
                      }}
                      required
                      fullWidth
                      error={Boolean(field.error)}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <MailOutlined />
                            </InputAdornment>
                          ),
                        },
                        htmlInput: { 'aria-describedby': field.describedBy },
                      }}
                    />
                  )}
                </FormField>

                <FormActions submitLabel={t('forgotPassword.submit')} submitting={loading} layout="stacked" />

                <Button component={LocaleLink} variant="text" href="/auth/login">
                  {t('forgotPassword.back')}
                </Button>
              </FormShell>
            )}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
