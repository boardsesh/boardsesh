'use client';

import React from 'react';
import MuiAlert from '@mui/material/Alert';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import CancelOutlined from '@mui/icons-material/CancelOutlined';
import { useSearchParams } from 'next/navigation';
import Logo from '@/app/components/brand/logo';
import BackButton from '@/app/components/back-button';
import { themeTokens } from '@/app/theme/theme-config';

export default function AuthErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get('error');

  const getErrorMessage = () => {
    switch (error) {
      case 'Configuration':
        return 'There is a problem with the server configuration.';
      case 'AccessDenied':
        return 'Access denied. You do not have permission to sign in.';
      case 'Verification':
        return 'The verification link has expired or is invalid.';
      case 'OAuthSignin':
        return 'Error starting the sign-in flow. Please try again.';
      case 'OAuthCallback':
        return 'Error completing the sign-in. Please try again.';
      case 'OAuthCreateAccount':
        return 'Could not create an account with this provider.';
      case 'EmailCreateAccount':
        return 'Could not create an email account.';
      case 'Callback':
        return 'Error in the authentication callback.';
      case 'OAuthAccountNotLinked':
        return 'This email is already linked to an account that uses a different sign-in method. Sign in with your original method, then connect this provider in Settings.';
      case 'SessionRequired':
        return 'You must be signed in to access this page.';
      default:
        return 'An unexpected authentication error occurred.';
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
          Authentication Error
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
              <CancelOutlined sx={{ fontSize: 48, color: themeTokens.colors.error, mx: 'auto' }} />
              <Typography variant="h3">Authentication Error</Typography>
              <MuiAlert severity="error">{getErrorMessage()}</MuiAlert>
              {error === 'OAuthAccountNotLinked' && (
                <Button variant="outlined" href="/settings" fullWidth size="large">
                  Connect accounts in Settings
                </Button>
              )}
              <Button variant="contained" href="/auth/login" fullWidth size="large">
                Back to Login
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
