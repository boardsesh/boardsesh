'use client';

import React, { useCallback, useEffect, useId, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { isAuthBackendUnavailable } from '@boardsesh/auth-protocol/client-errors';
import Logo from '@/app/components/brand/logo';
import LocaleLink from '@/app/components/i18n/locale-link';
import { bridgeLegacyBrowserSession, signInWithSessionIntent } from '@/app/lib/auth/web-session-events';
import { guardedFetch } from '@/app/lib/auth/session-guard';
import { GOOGLE_FORCED_REAUTHENTICATION } from '@/app/lib/auth/google-forced-reauthentication';
import { themeTokens } from '@/app/theme/theme-config';

export type ReauthenticationOutcome = 'other_account' | 'expired';

type ReauthenticateContentProps = {
  email: string;
  callbackUrl: string;
  /** Set when the browser came back from a sign-in that could not continue. */
  outcome?: ReauthenticationOutcome;
};
type Methods = { password: boolean; google: boolean };
type Failure = 'wrongPassword' | 'rateLimited' | 'unavailable' | 'failed';

/** Where every sign-in on this page returns: it forwards only when the same account came back. */
export const REAUTHENTICATION_RETURN_PATH = '/api/auth/reauthenticate/return';

class CanonicalSessionRequired extends Error {}

async function readMethods(): Promise<Methods | undefined> {
  const response = await guardedFetch('/api/auth/provider-security/methods', { cache: 'no-store' });
  const body: unknown = await response.json().catch(() => undefined);
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    if (response.status === 403 && fields.outcome === 'canonical_session_required')
      throw new CanonicalSessionRequired();
    return undefined;
  }
  const reauthentication = fields.reauthentication;
  if (!reauthentication || typeof reauthentication !== 'object') return undefined;
  const { password, google } = reauthentication as Record<string, unknown>;
  return { password: password === true, google: google === true };
}

/**
 * Which ways this account can confirm it is the climber, from the
 * provider-security methods read. A legacy-only browser is bridged by a
 * session read and asked once more; any other failure shows an error and no
 * buttons, so an Apple-only account is never offered Google.
 */
function useReauthenticationMethods() {
  const [methods, setMethods] = useState<Methods | 'failed'>();
  const load = useCallback(async () => {
    setMethods(undefined);
    try {
      let read: Methods | undefined;
      try {
        read = await readMethods();
      } catch (error) {
        if (!(error instanceof CanonicalSessionRequired)) throw error;
        await bridgeLegacyBrowserSession();
        read = await readMethods();
      }
      setMethods(read ?? 'failed');
    } catch {
      setMethods('failed');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { methods, reload: load };
}

/** Records who started and where to return, in a sealed cookie, before any sign-in. */
async function startReauthentication(callbackUrl: string): Promise<boolean> {
  const response = await guardedFetch('/api/auth/reauthenticate/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callbackUrl }),
  });
  return response.ok;
}

export default function ReauthenticateContent({ email, callbackUrl, outcome }: ReauthenticateContentProps) {
  const { t } = useTranslation('auth');
  const { methods, reload } = useReauthenticationMethods();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const ready = methods !== undefined && methods !== 'failed' ? methods : undefined;

  async function confirmWithPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!password || pending) return;
    setPending(true);
    setFailure(null);
    try {
      if (!(await startReauthentication(callbackUrl))) {
        setFailure('failed');
        return;
      }
      // A real password sign-in of this account: the new session's sign-in time is now.
      const result = await signInWithSessionIntent('credentials', { email, password, redirect: false });
      if (result?.ok && !result.error) {
        window.location.assign(REAUTHENTICATION_RETURN_PATH);
        return;
      }
      if (result?.status === 429) setFailure('rateLimited');
      else if (isAuthBackendUnavailable(result?.error)) setFailure('unavailable');
      else if (result?.error === 'CredentialsSignin') setFailure('wrongPassword');
      else setFailure('failed');
    } catch {
      setFailure('failed');
    } finally {
      setPending(false);
    }
  }

  async function confirmWithGoogle() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      if (!(await startReauthentication(callbackUrl))) {
        setFailure('failed');
        return;
      }
      const result = await signInWithSessionIntent(
        'google',
        { callbackUrl: REAUTHENTICATION_RETURN_PATH },
        // The account's address as a hint: Google preselects it when it is the connected one.
        { ...GOOGLE_FORCED_REAUTHENTICATION, login_hint: email },
      );
      if (result?.error) setFailure('failed');
    } catch {
      setFailure('failed');
    } finally {
      setPending(false);
    }
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
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('reauthenticate.header')}
        </Typography>
      </Box>
      <Box component="main" sx={{ padding: '24px', display: 'flex', justifyContent: 'center', paddingTop: '48px' }}>
        <Card sx={{ width: '100%', maxWidth: 400 }}>
          <CardContent>
            {outcome === 'other_account' ? (
              <Stack spacing={3}>
                <Typography variant="h3" component="h1">
                  {t('reauthenticate.otherAccountTitle')}
                </Typography>
                <Alert severity="warning">{t('reauthenticate.otherAccount', { email })}</Alert>
                <Button variant="contained" component={LocaleLink} href="/auth/signout">
                  {t('reauthenticate.signOut')}
                </Button>
                <Button variant="text" component={LocaleLink} href="/">
                  {t('reauthenticate.goHome')}
                </Button>
              </Stack>
            ) : (
              <Stack spacing={3}>
                <Typography variant="h3" component="h1">
                  {t('reauthenticate.title')}
                </Typography>
                <Typography>{t('reauthenticate.description', { email })}</Typography>
                {outcome === 'expired' && <Alert severity="info">{t('reauthenticate.expired')}</Alert>}
                {failure === 'wrongPassword' && <Alert severity="error">{t('reauthenticate.wrongPassword')}</Alert>}
                {failure === 'rateLimited' && <Alert severity="error">{t('reauthenticate.rateLimited')}</Alert>}
                {failure === 'unavailable' && <Alert severity="error">{t('reauthenticate.unavailable')}</Alert>}
                {failure === 'failed' && <Alert severity="error">{t('reauthenticate.failed')}</Alert>}
                {methods === undefined && <CircularProgress size={32} sx={{ alignSelf: 'center' }} />}
                {methods === 'failed' && (
                  <Alert
                    severity="error"
                    action={
                      <Button color="inherit" size="small" onClick={() => void reload()}>
                        {t('reauthenticate.retry')}
                      </Button>
                    }
                  >
                    {t('reauthenticate.methodsFailed')}
                  </Alert>
                )}
                {ready?.password && (
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
                {ready?.google && (
                  <Button variant="outlined" size="large" fullWidth disabled={pending} onClick={confirmWithGoogle}>
                    {t('reauthenticate.google')}
                  </Button>
                )}
                {ready && !ready.password && !ready.google && (
                  <Alert severity="info">{t('reauthenticate.appleOnly')}</Alert>
                )}
                <Button variant="text" component={LocaleLink} href={callbackUrl}>
                  {t('reauthenticate.cancel')}
                </Button>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
