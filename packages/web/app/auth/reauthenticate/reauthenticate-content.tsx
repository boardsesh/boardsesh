'use client';

import React, { useEffect, useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import { signInWithSessionIntent } from '@/app/lib/auth/web-session-events';
import { guardedFetch } from '@/app/lib/auth/session-guard';
import { GOOGLE_FORCED_REAUTHENTICATION } from '@/app/lib/auth/google-forced-reauthentication';
import { themeTokens } from '@/app/theme/theme-config';

type ReauthenticateContentProps = { email: string; callbackUrl: string };
type Methods = { password: boolean; google: boolean };

/**
 * Which ways this account can confirm it is the climber: the provider-security
 * methods read (#7596 B5e1), or both when it does not answer (its route is off
 * or not deployed yet).
 */
function useReauthenticationMethods(): Methods | undefined {
  const [methods, setMethods] = useState<Methods>();
  useEffect(() => {
    let current = true;
    guardedFetch('/api/auth/provider-security/methods', { cache: 'no-store' })
      .then(async (response) => {
        const body: unknown = response.ok ? await response.json() : undefined;
        const reauthentication =
          body && typeof body === 'object' ? (body as { reauthentication?: unknown }).reauthentication : undefined;
        const read =
          reauthentication && typeof reauthentication === 'object'
            ? (reauthentication as { password?: unknown; google?: unknown })
            : undefined;
        if (current)
          setMethods(
            read
              ? { password: read.password === true, google: read.google === true }
              : { password: true, google: true },
          );
      })
      .catch(() => {
        if (current) setMethods({ password: true, google: true });
      });
    return () => {
      current = false;
    };
  }, []);
  return methods;
}

export default function ReauthenticateContent({ email, callbackUrl }: ReauthenticateContentProps) {
  const { t } = useTranslation('auth');
  const methods = useReauthenticationMethods();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<'password' | 'other' | null>(null);

  async function confirmWithPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setFailure(null);
    try {
      // A real password sign-in of this account: the new session's sign-in time is now.
      const result = await signInWithSessionIntent('credentials', { email, password, redirect: false });
      if (result?.error || !result?.ok) {
        setFailure('password');
        return;
      }
      window.location.assign(callbackUrl);
    } catch {
      setFailure('other');
    } finally {
      setPending(false);
    }
  }

  async function confirmWithGoogle() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await signInWithSessionIntent('google', { callbackUrl }, GOOGLE_FORCED_REAUTHENTICATION);
      if (result?.error) setFailure('other');
    } catch {
      setFailure('other');
    } finally {
      setPending(false);
    }
  }

  const noMethod = methods !== undefined && !methods.password && !methods.google;
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
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('reauthenticate.header')}
        </Typography>
      </Box>
      <Box component="main" sx={{ padding: '24px', display: 'flex', justifyContent: 'center', paddingTop: '48px' }}>
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent>
            <Stack spacing={3}>
              <Typography variant="h3" component="h1">
                {t('reauthenticate.title')}
              </Typography>
              <Typography>{t('reauthenticate.description', { email })}</Typography>
              {failure === 'password' && <Alert severity="error">{t('reauthenticate.wrongPassword')}</Alert>}
              {failure === 'other' && <Alert severity="error">{t('reauthenticate.failed')}</Alert>}
              {methods?.password && (
                <Box component="form" onSubmit={confirmWithPassword}>
                  <Stack spacing={2}>
                    <TextField
                      id={passwordId}
                      type="password"
                      label={t('reauthenticate.passwordLabel')}
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      fullWidth
                    />
                    <Button type="submit" variant="contained" size="large" fullWidth disabled={pending || !password}>
                      {t('reauthenticate.submit')}
                    </Button>
                  </Stack>
                </Box>
              )}
              {methods?.google && (
                <Button variant="outlined" size="large" fullWidth disabled={pending} onClick={confirmWithGoogle}>
                  {t('reauthenticate.google')}
                </Button>
              )}
              {noMethod && <Alert severity="info">{t('reauthenticate.appleOnly')}</Alert>}
              <Button variant="text" href={callbackUrl}>
                {t('reauthenticate.cancel')}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
