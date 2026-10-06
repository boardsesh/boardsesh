'use client';

import { useState, useEffect, useId } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import MuiLink from '@mui/material/Link';
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
import { FormShell, FormSection, FormField, FormActions, focusFirstInvalidAfterRender } from '@/app/components/form';
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
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { authMethodFromError, safeAuthError } from './auth-error-classification';
import LocaleLink from '@/app/components/i18n/locale-link';

export default function AuthPageContent() {
  const { t } = useTranslation('auth');
  const { status } = useSession();
  const router = useLocaleRouter();
  const pathnameWithoutLocale = usePathnameWithoutLocale();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/';
  const error = searchParams.get('error');
  const { showMessage } = useSnackbar();
  const loginFormId = useId();
  const registerFormId = useId();

  const [loginValues, setLoginValues] = useState(initialLoginValues);
  const [loginErrors, setLoginErrors] = useState<LoginErrors>({});
  const [loginServerError, setLoginServerError] = useState<string | null>(null);
  const [registerValues, setRegisterValues] = useState(initialRegisterValues);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [registerServerError, setRegisterServerError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');

  const verified = searchParams.get('verified');

  // Surface NextAuth redirect errors (failed OAuth round-trip or credentials
  // redirect) as the login form's inline alert rather than a transient toast —
  // the form is on screen, so the error belongs with it.
  useEffect(() => {
    if (error) {
      if (error === 'CredentialsSignin') {
        setLoginServerError(t('login.toasts.invalidCredentials'));
      } else {
        setLoginServerError(t('login.toasts.authFailed'));
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
  }, [error, t, router, pathnameWithoutLocale, searchParams]);

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
    setLoginServerError(null);
    const errors = validateLoginFields(loginValues, t);
    setLoginErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirstInvalidAfterRender(loginFormId);
      return;
    }

    try {
      setLoginLoading(true);
      track('Login Attempted', { auth_method: 'credentials' });

      const result = await signIn('credentials', {
        email: loginValues.email,
        password: loginValues.password,
        redirect: false,
      });

      if (result?.error) {
        setLoginServerError(t('login.toasts.invalidCredentials'));
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
      // A thrown signIn (network down, server unreachable) must not leave the
      // form frozen with no feedback — surface it like the auth-error path.
      console.error('Login error:', error);
      setLoginServerError(t('login.toasts.authFailed'));
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async () => {
    setRegisterServerError(null);
    const errors = validateRegisterFields(registerValues, t);
    setRegisterErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirstInvalidAfterRender(registerFormId);
      return;
    }

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
        setRegisterServerError(data.error || t('login.toasts.registrationFailed'));
        return;
      }

      track(SHARED_EVENTS.SignupCompleted, {
        auth_method: 'credentials',
        requires_verification: Boolean(data.requiresVerification),
      });
      // First-touch attribution — written once and never overwritten.
      // PostHog merges these onto the authenticated user once AnalyticsIdentity
      // sends identify(userId) after the auto-signin below.
      //
      // Caveat: if requires_verification is true, we hit the early return below
      // and the auto-signin never runs, so that identify() does not fire in this session.
      // signup_at / signup_auth_method then live on the anonymous distinct_id
      // until the user comes back to verify and log in — at which point PostHog
      // merges them onto the authenticated user. Until that merge they're
      // visible in Live Events under the anon profile, which can briefly skew
      // person-property dashboards.
      setPersonProperties(undefined, {
        signup_at: new Date().toISOString(),
        signup_auth_method: 'credentials',
      });

      // Check if email verification is required
      if (data.requiresVerification) {
        showMessage(t('login.toasts.checkEmail'), 'info');
        setActiveTab('login');
        setLoginValues((prev) => ({ ...prev, email: registerValues.email }));
        return;
      }

      // Email verification disabled - auto-login after successful registration
      showMessage(t('login.toasts.accountCreated'), 'success');

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
      setRegisterServerError(t('login.toasts.registrationFailedRetry'));
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

            <Tabs
              value={activeTab}
              onChange={(_, selectedTab) => {
                setActiveTab(selectedTab);
                // Errors belong to the submit that produced them — don't
                // resurface stale ones after a tab round-trip.
                setLoginServerError(null);
                setRegisterServerError(null);
                setLoginErrors({});
                setRegisterErrors({});
              }}
              centered
            >
              <Tab label={t('login.tabs.signIn')} value="login" />
              <Tab label={t('login.tabs.signUp')} value="register" />
            </Tabs>

            <TabPanel value={activeTab} index="login">
              <FormShell
                id={loginFormId}
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleLogin();
                }}
                error={loginServerError}
                maxWidth={false}
              >
                <FormSection>
                  <FormField label={t('login.fields.email')} error={loginErrors.email}>
                    {(field) => (
                      <TextField
                        id={field.id}
                        type="email"
                        autoComplete="username"
                        placeholder={t('login.placeholders.email')}
                        fullWidth
                        value={loginValues.email}
                        onChange={(e) => {
                          setLoginValues((prev) => ({ ...prev, email: e.target.value }));
                          if (loginErrors.email) setLoginErrors((prev) => ({ ...prev, email: undefined }));
                          if (loginServerError) setLoginServerError(null);
                        }}
                        error={Boolean(field.error)}
                        slotProps={{
                          input: {
                            startAdornment: (
                              <InputAdornment position="start">
                                <MailOutlined />
                              </InputAdornment>
                            ),
                          },
                          htmlInput: { autoCapitalize: 'none', 'aria-describedby': field.describedBy },
                        }}
                      />
                    )}
                  </FormField>

                  <FormField
                    label={t('login.fields.password')}
                    error={loginErrors.password}
                    labelAccessory={
                      <MuiLink component={LocaleLink} href="/auth/forgot-password" variant="body2">
                        {t('login.links.forgotPassword')}
                      </MuiLink>
                    }
                  >
                    {(field) => (
                      <TextField
                        id={field.id}
                        type="password"
                        autoComplete="current-password"
                        placeholder={t('login.placeholders.password')}
                        fullWidth
                        value={loginValues.password}
                        onChange={(e) => {
                          setLoginValues((prev) => ({ ...prev, password: e.target.value }));
                          if (loginErrors.password) setLoginErrors((prev) => ({ ...prev, password: undefined }));
                          if (loginServerError) setLoginServerError(null);
                        }}
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
                </FormSection>

                <FormActions submitLabel={t('login.submit.signIn')} submitting={loginLoading} layout="stacked" />
              </FormShell>
            </TabPanel>

            <TabPanel value={activeTab} index="register">
              <FormShell
                id={registerFormId}
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleRegister();
                }}
                error={registerServerError}
                maxWidth={false}
              >
                <FormSection>
                  <FormField label={t('login.fields.name')} error={registerErrors.name}>
                    {(field) => (
                      <TextField
                        id={field.id}
                        autoComplete="name"
                        placeholder={t('login.placeholders.name')}
                        fullWidth
                        value={registerValues.name}
                        onChange={(e) => {
                          setRegisterValues((prev) => ({ ...prev, name: e.target.value }));
                          if (registerErrors.name) setRegisterErrors((prev) => ({ ...prev, name: undefined }));
                          if (registerServerError) setRegisterServerError(null);
                        }}
                        error={Boolean(field.error)}
                        slotProps={{
                          input: {
                            startAdornment: (
                              <InputAdornment position="start">
                                <PersonOutlined />
                              </InputAdornment>
                            ),
                          },
                          htmlInput: { 'aria-describedby': field.describedBy },
                        }}
                      />
                    )}
                  </FormField>

                  <FormField label={t('login.fields.email')} error={registerErrors.email}>
                    {(field) => (
                      <TextField
                        id={field.id}
                        type="email"
                        autoComplete="email"
                        placeholder={t('login.placeholders.email')}
                        fullWidth
                        value={registerValues.email}
                        onChange={(e) => {
                          setRegisterValues((prev) => ({ ...prev, email: e.target.value }));
                          if (registerErrors.email) setRegisterErrors((prev) => ({ ...prev, email: undefined }));
                          if (registerServerError) setRegisterServerError(null);
                        }}
                        error={Boolean(field.error)}
                        slotProps={{
                          input: {
                            startAdornment: (
                              <InputAdornment position="start">
                                <MailOutlined />
                              </InputAdornment>
                            ),
                          },
                          htmlInput: { autoCapitalize: 'none', 'aria-describedby': field.describedBy },
                        }}
                      />
                    )}
                  </FormField>

                  <FormField label={t('login.fields.password')} error={registerErrors.password}>
                    {(field) => (
                      <TextField
                        id={field.id}
                        type="password"
                        autoComplete="new-password"
                        placeholder={t('login.placeholders.passwordWithMin')}
                        fullWidth
                        value={registerValues.password}
                        onChange={(e) => {
                          setRegisterValues((prev) => ({ ...prev, password: e.target.value }));
                          if (registerErrors.password) setRegisterErrors((prev) => ({ ...prev, password: undefined }));
                          if (registerServerError) setRegisterServerError(null);
                        }}
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

                  <FormField label={t('login.fields.confirmPassword')} error={registerErrors.confirmPassword}>
                    {(field) => (
                      <TextField
                        id={field.id}
                        type="password"
                        autoComplete="new-password"
                        placeholder={t('login.placeholders.confirmPassword')}
                        fullWidth
                        value={registerValues.confirmPassword}
                        onChange={(e) => {
                          setRegisterValues((prev) => ({ ...prev, confirmPassword: e.target.value }));
                          if (registerErrors.confirmPassword)
                            setRegisterErrors((prev) => ({ ...prev, confirmPassword: undefined }));
                          if (registerServerError) setRegisterServerError(null);
                        }}
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
                </FormSection>

                <FormActions submitLabel={t('login.submit.signUp')} submitting={registerLoading} layout="stacked" />
              </FormShell>
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
