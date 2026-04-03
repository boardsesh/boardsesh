'use client';

import React, { useState, useEffect } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import MailOutlined from '@mui/icons-material/MailOutlined';
import { signIn, useSession } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import SocialLoginButtons from '@/app/components/auth/social-login-buttons';
import {
  initialLoginValues,
  initialRegisterValues,
  validateLoginFields,
  validateRegisterFields,
  type LoginErrors,
  type RegisterErrors,
} from '@/app/components/auth/validate-fields';
import { TabPanel } from '@/app/components/ui/tab-panel';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import { track, setPersonProperties } from '@/app/lib/analytics';
import { authMethodFromError, safeAuthError } from './auth-error-classification';

export default function AuthPageContent() {
  const { t } = useTranslation('auth');
  const { status } = useSession();
  const router = useLocaleRouter();
  const pathnameWithoutLocale = usePathnameWithoutLocale();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const error = searchParams.get('error');
  const { showMessage } = useSnackbar();

  const [loginValues, setLoginValues] = useState(initialLoginValues);
  const [loginErrors, setLoginErrors] = useState<LoginErrors>({});
  const [registerValues, setRegisterValues] = useState(initialRegisterValues);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');

  const verified = searchParams.get('verified');

  // Show error message from NextAuth
  useEffect(() => {
    if (error) {
      if (error === 'CredentialsSignin') {
        showMessage(t('login.toasts.invalidCredentials'), 'error');
      } else {
        showMessage(t('login.toasts.authFailed'), 'error');
      }
      // NextAuth redirects back to /auth/login?error=... after either a failed
      // OAuth round-trip or — under some flows — a credentials redirect path.
      // CredentialsSignin is the credentials code; everything else in the known
      // enum is OAuth-shaped. Tag accordingly so funnel splits stay honest.
      track('Login Failed', {
        auth_method: authMethodFromError(error),
        failure_reason: safeAuthError(error),
      });
      // Strip the ?error= param so a refresh or back-navigation doesn't fire
      // Login Failed again and re-show the toast. preserve callbackUrl if set.
      const cleanParams = new URLSearchParams(searchParams.toString());
      cleanParams.delete('error');
      const queryString = cleanParams.toString();
      router.replace(queryString ? `${pathnameWithoutLocale}?${queryString}` : pathnameWithoutLocale);
    }
  }, [error, showMessage, t, router, pathnameWithoutLocale, searchParams]);

  // Show success message when email is verified
  useEffect(() => {
    if (verified === 'true') {
      showMessage(t('login.toasts.verified'), 'success');
    }
  }, [verified, showMessage, t]);

  // Redirect if already authenticated
  useEffect(() => {
    if (status === 'authenticated') {
      router.push(callbackUrl);
    }
  }, [status, router, callbackUrl]);

  const handleLogin = async () => {
    const errors = validateLoginFields(loginValues, t);
    setLoginErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      setLoginLoading(true);
      track('Login Attempted', { auth_method: 'credentials' });

      const result = await signIn('credentials', {
        email: loginValues.email,
        password: loginValues.password,
        redirect: false,
      });

      if (result?.error) {
        showMessage(t('login.toasts.invalidCredentials'), 'error');
        track('Login Failed', {
          auth_method: 'credentials',
          failure_reason: safeAuthError(result.error),
        });
      } else if (result?.ok) {
        showMessage(t('login.toasts.loggedIn'), 'success');
        track('Login Succeeded', { auth_method: 'credentials' });
        router.push(callbackUrl);
      }
    } catch (error) {
      console.error('Login error:', error);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async () => {
    const errors = validateRegisterFields(registerValues, t);
    setRegisterErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      setRegisterLoading(true);

      // Call registration API
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: registerValues.email,
          password: registerValues.password,
          name: registerValues.name,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(data.error || t('login.toasts.registrationFailed'), 'error');
        return;
      }

      track('Signup Completed', {
        auth_method: 'credentials',
        verification_email_sent: Boolean(data.emailSent),
      });
      // First-touch attribution — written once and never overwritten.
      // PostHog merges these onto the authenticated user once alias() runs
      // in party-profile-context after the auto-signin below. Verification is
      // non-blocking, so the auto-signin always runs and alias() fires this session.
      setPersonProperties(undefined, {
        signup_at: new Date().toISOString(),
        signup_auth_method: 'credentials',
      });

      // Verification is non-blocking: always auto-login. When a verification email went
      // out, nudge the user to check their inbox; otherwise just confirm and sign in.
      showMessage(
        data.emailSent ? t('login.toasts.accountCreatedCheckEmail') : t('login.toasts.accountCreated'),
        'success',
      );

      const loginResult = await signIn('credentials', {
        email: registerValues.email,
        password: registerValues.password,
        redirect: false,
      });

      if (loginResult?.ok) {
        track('Login Succeeded', {
          auth_method: 'credentials',
          is_first_login: true,
        });
        router.push(callbackUrl);
      } else {
        setActiveTab('login');
        setLoginValues((prev) => ({ ...prev, email: registerValues.email }));
        showMessage(t('login.toasts.loginAfterCreate'), 'info');
      }
    } catch (error) {
      console.error('Registration error:', error);
      showMessage(t('login.toasts.registrationFailedRetry'), 'error');
    } finally {
      setRegisterLoading(false);
    }
  };

  if (status === 'loading') {
    return null;
  }

  if (status === 'authenticated') {
    return null;
  }

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
          {t('login.header')}
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
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent>
            <Stack spacing={1} sx={{ width: '100%', textAlign: 'center', marginBottom: 3 }}>
              <Logo size="md" />
              <Typography variant="body2" component="span" color="text.secondary">
                {t('login.subtitle')}
              </Typography>
            </Stack>

            <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} centered>
              <Tab label={t('login.tabs.signIn')} value="login" />
              <Tab label={t('login.tabs.signUp')} value="register" />
            </Tabs>

            <TabPanel value={activeTab} index="login">
              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  void handleLogin();
                }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <TextField
                  label={t('login.fields.email')}
                  placeholder={t('login.placeholders.email')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={loginValues.email}
                  onChange={(e) => {
                    setLoginValues((prev) => ({ ...prev, email: e.target.value }));
                    if (loginErrors.email) setLoginErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  error={!!loginErrors.email}
                  helperText={loginErrors.email}
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

                <TextField
                  label={t('login.fields.password')}
                  type="password"
                  placeholder={t('login.placeholders.password')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={loginValues.password}
                  onChange={(e) => {
                    setLoginValues((prev) => ({ ...prev, password: e.target.value }));
                    if (loginErrors.password) setLoginErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  error={!!loginErrors.password}
                  helperText={loginErrors.password}
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
                  type="submit"
                  disabled={loginLoading}
                  startIcon={loginLoading ? <CircularProgress size={16} /> : undefined}
                  fullWidth
                  size="large"
                >
                  {t('login.submit.signIn')}
                </Button>
              </Box>
            </TabPanel>

            <TabPanel value={activeTab} index="register">
              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => {
                  e.preventDefault();
                  void handleRegister();
                }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <TextField
                  label={t('login.fields.name')}
                  placeholder={t('login.placeholders.name')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.name}
                  onChange={(e) => {
                    setRegisterValues((prev) => ({ ...prev, name: e.target.value }));
                    if (registerErrors.name) setRegisterErrors((prev) => ({ ...prev, name: undefined }));
                  }}
                  error={!!registerErrors.name}
                  helperText={registerErrors.name}
                  slotProps={{
                    input: {
                      startAdornment: (
                        <InputAdornment position="start">
                          <PersonOutlined />
                        </InputAdornment>
                      ),
                    },
                  }}
                />

                <TextField
                  label={t('login.fields.email')}
                  placeholder={t('login.placeholders.email')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.email}
                  onChange={(e) => {
                    setRegisterValues((prev) => ({ ...prev, email: e.target.value }));
                    if (registerErrors.email) setRegisterErrors((prev) => ({ ...prev, email: undefined }));
                  }}
                  error={!!registerErrors.email}
                  helperText={registerErrors.email}
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

                <TextField
                  label={t('login.fields.password')}
                  type="password"
                  placeholder={t('login.placeholders.passwordWithMin')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.password}
                  onChange={(e) => {
                    setRegisterValues((prev) => ({ ...prev, password: e.target.value }));
                    if (registerErrors.password) setRegisterErrors((prev) => ({ ...prev, password: undefined }));
                  }}
                  error={!!registerErrors.password}
                  helperText={registerErrors.password}
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
                  label={t('login.fields.confirmPassword')}
                  type="password"
                  placeholder={t('login.placeholders.confirmPassword')}
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.confirmPassword}
                  onChange={(e) => {
                    setRegisterValues((prev) => ({ ...prev, confirmPassword: e.target.value }));
                    if (registerErrors.confirmPassword)
                      setRegisterErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                  }}
                  error={!!registerErrors.confirmPassword}
                  helperText={registerErrors.confirmPassword}
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
                  type="submit"
                  disabled={registerLoading}
                  startIcon={registerLoading ? <CircularProgress size={16} /> : undefined}
                  fullWidth
                  size="large"
                >
                  {t('login.submit.signUp')}
                </Button>
              </Box>
            </TabPanel>

            <MuiDivider>
              <Typography variant="body2" component="span" color="text.secondary">
                {t('login.divider')}
              </Typography>
            </MuiDivider>

            <SocialLoginButtons callbackUrl={callbackUrl} />
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
