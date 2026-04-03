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
import { useRouter, useSearchParams } from 'next/navigation';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import SocialLoginButtons from '@/app/components/auth/social-login-buttons';
import { TabPanel } from '@/app/components/ui/tab-panel';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const initialLoginValues = { email: '', password: '' };
const initialRegisterValues = { name: '', email: '', password: '', confirmPassword: '' };

type LoginErrors = Partial<Record<keyof typeof initialLoginValues, string>>;
type RegisterErrors = Partial<Record<keyof typeof initialRegisterValues, string>>;

function validateLoginFields(values: typeof initialLoginValues): LoginErrors {
  const errors: LoginErrors = {};
  if (!values.email) {
    errors.email = 'Please enter your email';
  } else if (!EMAIL_REGEX.test(values.email)) {
    errors.email = 'Please enter a valid email';
  }
  if (!values.password) {
    errors.password = 'Please enter your password';
  }
  return errors;
}

function validateRegisterFields(values: typeof initialRegisterValues): RegisterErrors {
  const errors: RegisterErrors = {};
  if (values.name && values.name.length > 100) {
    errors.name = 'Name must be less than 100 characters';
  }
  if (!values.email) {
    errors.email = 'Please enter your email';
  } else if (!EMAIL_REGEX.test(values.email)) {
    errors.email = 'Please enter a valid email';
  }
  if (!values.password) {
    errors.password = 'Please enter a password';
  } else if (values.password.length < 8) {
    errors.password = 'Password must be at least 8 characters';
  }
  if (!values.confirmPassword) {
    errors.confirmPassword = 'Please confirm your password';
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = 'Passwords do not match';
  }
  return errors;
}

export default function AuthPageContent() {
  const { status } = useSession();
  const router = useRouter();
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
        showMessage('Invalid email or password', 'error');
      } else {
        showMessage('Authentication failed. Please try again.', 'error');
      }
    }
  }, [error, showMessage]);

  // Show success message when email is verified
  useEffect(() => {
    if (verified === 'true') {
      showMessage('Email verified! You can now log in.', 'success');
    }
  }, [verified, showMessage]);

  // Redirect if already authenticated
  useEffect(() => {
    if (status === 'authenticated') {
      router.push(callbackUrl);
    }
  }, [status, router, callbackUrl]);

  const handleLogin = async () => {
    const errors = validateLoginFields(loginValues);
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
        showMessage('Invalid email or password', 'error');
      } else if (result?.ok) {
        showMessage('Logged in successfully', 'success');
        router.push(callbackUrl);
      }
    } catch (error) {
      console.error('Login error:', error);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async () => {
    const errors = validateRegisterFields(registerValues);
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
        showMessage(data.error || 'Registration failed', 'error');
        return;
      }

      // Check if email verification is required
      if (data.requiresVerification) {
        showMessage('Please check your email to verify your account', 'info');
        setActiveTab('login');
        setLoginValues(prev => ({ ...prev, email: registerValues.email }));
        return;
      }

      // Email verification disabled - auto-login after successful registration
      showMessage('Account created! Logging you in...', 'success');

      const loginResult = await signIn('credentials', {
        email: registerValues.email,
        password: registerValues.password,
        redirect: false,
      });

      if (loginResult?.ok) {
        router.push(callbackUrl);
      } else {
        setActiveTab('login');
        setLoginValues(prev => ({ ...prev, email: registerValues.email }));
        showMessage('Please log in with your account', 'info');
      }
    } catch (error) {
      console.error('Registration error:', error);
      showMessage('Registration failed. Please try again.', 'error');
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
          Welcome
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
              <Typography variant="body2" component="span" color="text.secondary">Sign in or create an account to continue</Typography>
            </Stack>

            <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} centered>
              <Tab label="Login" value="login" />
              <Tab label="Create Account" value="register" />
            </Tabs>

            <TabPanel value={activeTab} index="login">
              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => { e.preventDefault(); handleLogin(); }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <TextField
                  label="Email"
                  placeholder="your@email.com"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={loginValues.email}
                  onChange={(e) => {
                    setLoginValues(prev => ({ ...prev, email: e.target.value }));
                    if (loginErrors.email) setLoginErrors(prev => ({ ...prev, email: undefined }));
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
                  label="Password"
                  type="password"
                  placeholder="Password"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={loginValues.password}
                  onChange={(e) => {
                    setLoginValues(prev => ({ ...prev, password: e.target.value }));
                    if (loginErrors.password) setLoginErrors(prev => ({ ...prev, password: undefined }));
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
                  Login
                </Button>

                <Button variant="text" href="/auth/forgot-password">
                  Forgot password?
                </Button>
              </Box>
            </TabPanel>

            <TabPanel value={activeTab} index="register">
              <Box
                component="form"
                onSubmit={(e: React.FormEvent) => { e.preventDefault(); handleRegister(); }}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
              >
                <TextField
                  label="Name"
                  placeholder="Your name (optional)"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.name}
                  onChange={(e) => {
                    setRegisterValues(prev => ({ ...prev, name: e.target.value }));
                    if (registerErrors.name) setRegisterErrors(prev => ({ ...prev, name: undefined }));
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
                  label="Email"
                  placeholder="your@email.com"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.email}
                  onChange={(e) => {
                    setRegisterValues(prev => ({ ...prev, email: e.target.value }));
                    if (registerErrors.email) setRegisterErrors(prev => ({ ...prev, email: undefined }));
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
                  label="Password"
                  type="password"
                  placeholder="Password (min 8 characters)"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.password}
                  onChange={(e) => {
                    setRegisterValues(prev => ({ ...prev, password: e.target.value }));
                    if (registerErrors.password) setRegisterErrors(prev => ({ ...prev, password: undefined }));
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
                  label="Confirm Password"
                  type="password"
                  placeholder="Confirm password"
                  variant="outlined"
                  size="medium"
                  fullWidth
                  value={registerValues.confirmPassword}
                  onChange={(e) => {
                    setRegisterValues(prev => ({ ...prev, confirmPassword: e.target.value }));
                    if (registerErrors.confirmPassword) setRegisterErrors(prev => ({ ...prev, confirmPassword: undefined }));
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
                  Create Account
                </Button>
              </Box>
            </TabPanel>

            <MuiDivider>
              <Typography variant="body2" component="span" color="text.secondary">or</Typography>
            </MuiDivider>

            <SocialLoginButtons callbackUrl={callbackUrl} />
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
