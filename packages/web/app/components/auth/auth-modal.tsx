'use client';

import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import Box from '@mui/material/Box';
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
};

export default function AuthModal({ open, onClose, onSuccess, title, description }: AuthModalProps) {
  const { t } = useTranslation('auth');
  const resolvedTitle = title ?? t('modal.title');
  const resolvedDescription = description ?? t('modal.description');
  const [loginValues, setLoginValues] = useState(initialLoginValues);
  const [loginErrors, setLoginErrors] = useState<LoginErrors>({});
  const [registerValues, setRegisterValues] = useState(initialRegisterValues);
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [loginLoading, setLoginLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const { showMessage } = useSnackbar();

  const handleLogin = async () => {
    const errors = validateLoginFields(loginValues, t);
    setLoginErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      setLoginLoading(true);

      const result = await signIn('credentials', {
        email: loginValues.email,
        password: loginValues.password,
        redirect: false,
      });

      if (result?.error) {
        showMessage(t('login.toasts.invalidCredentials'), 'error');
      } else if (result?.ok) {
        showMessage(t('login.toasts.loggedIn'), 'success');
        setLoginValues(initialLoginValues);
        setLoginErrors({});
        onClose();
        onSuccess?.();
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
        showMessage(data.error || t('login.toasts.registrationFailed'), 'error');
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
      showMessage(t('login.toasts.registrationFailedRetry'), 'error');
    } finally {
      setRegisterLoading(false);
    }
  };

  const handleCancel = () => {
    setLoginValues(initialLoginValues);
    setLoginErrors({});
    setRegisterValues(initialRegisterValues);
    setRegisterErrors({});
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
                id="login_email"
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
                    type: 'email',
                    autoCapitalize: 'none',
                    startAdornment: (
                      <InputAdornment position="start">
                        <MailOutlined />
                      </InputAdornment>
                    ),
                  },
                }}
              />

              <TextField
                id="login_password"
                type={showLoginPassword ? 'text' : 'password'}
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
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
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
                    type: 'email',
                    autoCapitalize: 'none',
                    startAdornment: (
                      <InputAdornment position="start">
                        <MailOutlined />
                      </InputAdornment>
                    ),
                  },
                }}
              />

              <TextField
                type={showRegisterPassword ? 'text' : 'password'}
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
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
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
                }}
              />

              <TextField
                type={showConfirmPassword ? 'text' : 'password'}
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
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
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

          <MuiDivider sx={{ margin: '8px 0' }}>
            <Typography variant="body2" component="span" color="text.secondary">
              {t('login.divider')}
            </Typography>
          </MuiDivider>

          <SocialLoginButtons />
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
