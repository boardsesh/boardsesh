'use client';

import { useState, useId } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import Stack from '@mui/material/Stack';
import MuiDivider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import LockOutlined from '@mui/icons-material/LockOutlined';
import MailOutlined from '@mui/icons-material/MailOutlined';
import Favorite from '@mui/icons-material/Favorite';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { signIn } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
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
import { generateRandomUsername } from '@/app/lib/generate-username';

type AuthModalProps = {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  title?: string;
  description?: string;
  /** Forwarded to the OAuth buttons; they default to '/' when it's absent. */
  callbackUrl?: string;
};

export default function AuthModal({ open, onClose, onSuccess, title, description, callbackUrl }: AuthModalProps) {
  const { t } = useTranslation('auth');
  const resolvedTitle = title ?? t('modal.title');
  const resolvedDescription = description ?? t('modal.description');
  const [loginValues, setLoginValues] = useState(initialLoginValues);
  const [loginErrors, setLoginErrors] = useState<LoginErrors>({});
  const [loginServerError, setLoginServerError] = useState<string | null>(null);
  const [registerValues, setRegisterValues] = useState(initialRegisterValues);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [registerServerError, setRegisterServerError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { showMessage } = useSnackbar();
  const loginFormId = useId();
  const registerFormId = useId();

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

      const result = await signIn('credentials', {
        email: loginValues.email,
        password: loginValues.password,
        redirect: false,
      });

      if (result?.error) {
        setLoginServerError(t('login.toasts.invalidCredentials'));
      } else if (result?.ok) {
        showMessage(t('login.toasts.loggedIn'), 'success');
        setLoginValues(initialLoginValues);
        setLoginErrors({});
        onClose();
        onSuccess?.();
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

      // Generate random username if name is empty
      const name = registerValues.name.trim() || generateRandomUsername();

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: registerValues.email,
          password: registerValues.password,
          name: name,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setRegisterServerError(data.error || t('login.toasts.registrationFailed'));
        return;
      }

      // Check if email verification is required
      if (data.requiresVerification) {
        showMessage(t('login.toasts.checkEmail'), 'info');
        setActiveTab('login');
        setLoginValues((prev) => ({ ...prev, email: registerValues.email }));
        setRegisterValues(initialRegisterValues);
        setRegisterErrors({});
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
        setRegisterValues(initialRegisterValues);
        setRegisterErrors({});
        onClose();
        onSuccess?.();
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

  const handleCancel = () => {
    setLoginValues(initialLoginValues);
    setLoginErrors({});
    setLoginServerError(null);
    setRegisterValues(initialRegisterValues);
    setRegisterErrors({});
    setRegisterServerError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleCancel} maxWidth="xs" fullWidth>
      <DialogContent>
        <Stack spacing={3} sx={{ width: '100%' }}>
          <Stack spacing={1} sx={{ width: '100%', textAlign: 'center' }}>
            <Favorite sx={{ fontSize: 32, color: 'var(--color-error)', mx: 'auto' }} />
            <Typography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 18 }}>
              {resolvedTitle}
            </Typography>
            <Typography variant="body2" component="span" color="text.secondary">
              {resolvedDescription}
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
                <FormField label={t('login.fields.email')} htmlFor="login_email" error={loginErrors.email}>
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

                <FormField label={t('login.fields.password')} htmlFor="login_password" error={loginErrors.password}>
                  {(field) => (
                    <TextField
                      id={field.id}
                      type={showLoginPassword ? 'text' : 'password'}
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
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                aria-label={
                                  showLoginPassword ? t('login.a11y.hidePassword') : t('login.a11y.showPassword')
                                }
                                onClick={() => setShowLoginPassword(!showLoginPassword)}
                                onMouseDown={(e) => e.preventDefault()}
                                edge="end"
                                size="small"
                                tabIndex={-1}
                              >
                                {showLoginPassword ? <VisibilityOff /> : <Visibility />}
                              </IconButton>
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
                <FormField label={t('login.fields.name')} htmlFor="register_name" error={registerErrors.name}>
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

                <FormField label={t('login.fields.email')} htmlFor="register_email" error={registerErrors.email}>
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

                <FormField
                  label={t('login.fields.password')}
                  htmlFor="register_password"
                  error={registerErrors.password}
                >
                  {(field) => (
                    <TextField
                      id={field.id}
                      type={showRegisterPassword ? 'text' : 'password'}
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
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                aria-label={
                                  showRegisterPassword ? t('login.a11y.hidePassword') : t('login.a11y.showPassword')
                                }
                                onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                                onMouseDown={(e) => e.preventDefault()}
                                edge="end"
                                size="small"
                                tabIndex={-1}
                              >
                                {showRegisterPassword ? <VisibilityOff /> : <Visibility />}
                              </IconButton>
                            </InputAdornment>
                          ),
                        },
                        htmlInput: { 'aria-describedby': field.describedBy },
                      }}
                    />
                  )}
                </FormField>

                <FormField
                  label={t('login.fields.confirmPassword')}
                  htmlFor="register_confirm_password"
                  error={registerErrors.confirmPassword}
                >
                  {(field) => (
                    <TextField
                      id={field.id}
                      type={showConfirmPassword ? 'text' : 'password'}
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
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                aria-label={
                                  showConfirmPassword
                                    ? t('login.a11y.hideConfirmPassword')
                                    : t('login.a11y.showConfirmPassword')
                                }
                                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                                onMouseDown={(e) => e.preventDefault()}
                                edge="end"
                                size="small"
                                tabIndex={-1}
                              >
                                {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                              </IconButton>
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

          <MuiDivider sx={{ margin: '8px 0' }}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('login.divider')}
            </Typography>
          </MuiDivider>

          <SocialLoginButtons callbackUrl={callbackUrl} />
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
