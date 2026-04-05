'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

type ProvidersConfig = {
  google: boolean;
  apple: boolean;
  facebook: boolean;
};

const PROVIDER_DISPLAY: Record<string, { name: string; icon: React.ReactNode }> = {
  google: {
    name: 'Google',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
      </svg>
    ),
  },
  apple: {
    name: 'Apple',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </svg>
    ),
  },
  facebook: {
    name: 'Facebook',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="#1877F2">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
};

interface ConnectedAccountsSectionProps {
  linkedProviders: string[];
  hasPassword: boolean;
  onProvidersChanged: () => void;
}

export default function ConnectedAccountsSection({
  linkedProviders,
  hasPassword,
  onProvidersChanged,
}: ConnectedAccountsSectionProps) {
  const [availableProviders, setAvailableProviders] = useState<ProvidersConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const { showMessage } = useSnackbar();
  const searchParams = useSearchParams();

  // Show success/error messages from URL params (after OAuth redirect)
  useEffect(() => {
    const linked = searchParams.get('linked');
    const linkError = searchParams.get('link_error');

    if (linked) {
      const name = PROVIDER_DISPLAY[linked]?.name ?? linked;
      showMessage(`${name} connected to your account`, 'success');
      // Clean up URL params
      const url = new URL(window.location.href);
      url.searchParams.delete('linked');
      window.history.replaceState({}, '', url.pathname);
    } else if (linkError === 'email_mismatch') {
      showMessage(
        "The email on that account doesn't match yours. Use the same email to connect.",
        'error',
      );
      const url = new URL(window.location.href);
      url.searchParams.delete('link_error');
      window.history.replaceState({}, '', url.pathname);
    } else if (linkError === 'expired') {
      showMessage('Link request expired. Try again.', 'error');
      const url = new URL(window.location.href);
      url.searchParams.delete('link_error');
      window.history.replaceState({}, '', url.pathname);
    }
  }, [searchParams, showMessage]);

  useEffect(() => {
    fetch('/api/auth/providers-config')
      .then((res) => res.json())
      .then((data: ProvidersConfig) => {
        setAvailableProviders(data);
        setLoading(false);
      })
      .catch(() => {
        setAvailableProviders({ google: false, apple: false, facebook: false });
        setLoading(false);
      });
  }, []);

  const handleConnect = useCallback(async (provider: string) => {
    setActionInProgress(provider);
    try {
      // Set the link intent cookie
      const response = await fetch('/api/internal/link-account', {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to initiate linking');
      }

      // Start the OAuth flow — it will redirect to the provider
      await signIn(provider, { callbackUrl: '/settings' });
    } catch (error) {
      console.error('Failed to connect provider:', error);
      showMessage('Failed to start connection. Try again.', 'error');
      setActionInProgress(null);
    }
  }, [showMessage]);

  const handleDisconnect = useCallback(async (provider: string) => {
    setActionInProgress(provider);
    try {
      const response = await fetch('/api/internal/link-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(data.error || 'Failed to disconnect', 'error');
        return;
      }

      const name = PROVIDER_DISPLAY[provider]?.name ?? provider;
      showMessage(`${name} disconnected`, 'success');
      onProvidersChanged();
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      showMessage('Failed to disconnect. Try again.', 'error');
    } finally {
      setActionInProgress(null);
    }
  }, [showMessage, onProvidersChanged]);

  if (loading) {
    return (
      <Card>
        <CardContent>
          <Typography variant="h5">Connected Accounts</Typography>
          <Skeleton variant="rectangular" height={48} sx={{ mt: 2 }} />
        </CardContent>
      </Card>
    );
  }

  // Only show providers that are configured on the server
  const providers = (['google', 'apple', 'facebook'] as const).filter(
    (p) => availableProviders?.[p],
  );

  if (providers.length === 0) {
    return null;
  }

  const canDisconnect = (provider: string) => {
    const otherProviders = linkedProviders.filter((p) => p !== provider);
    return otherProviders.length > 0 || hasPassword;
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h5">Connected Accounts</Typography>
        <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          Sign in faster with your existing accounts
        </Typography>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {providers.map((provider) => {
            const display = PROVIDER_DISPLAY[provider];
            const isLinked = linkedProviders.includes(provider);
            const isProcessing = actionInProgress === provider;
            const disabled = actionInProgress !== null;

            return (
              <Box
                key={provider}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  p: 1.5,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  {display.icon}
                </Box>
                <Typography variant="body1" sx={{ flex: 1 }}>
                  {display.name}
                </Typography>
                {isLinked ? (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CheckCircleOutlined color="success" fontSize="small" />
                    <Button
                      size="small"
                      color="error"
                      startIcon={isProcessing ? <CircularProgress size={14} /> : <LinkOffIcon />}
                      onClick={() => handleDisconnect(provider)}
                      disabled={disabled || !canDisconnect(provider)}
                    >
                      Disconnect
                    </Button>
                  </Box>
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={isProcessing ? <CircularProgress size={14} /> : <LinkIcon />}
                    onClick={() => handleConnect(provider)}
                    disabled={disabled}
                  >
                    Connect
                  </Button>
                )}
              </Box>
            );
          })}
        </Box>

        {linkedProviders.length > 0 &&
          !hasPassword &&
          linkedProviders.length === 1 && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Set a password below so you can disconnect this provider later.
            </Alert>
          )}
      </CardContent>
    </Card>
  );
}
