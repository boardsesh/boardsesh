'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import LocaleLink from '@/app/components/i18n/locale-link';
import { publicFirstPasswordReady } from '@/app/lib/auth/first-password-readiness';

type Confirmation = { operationKey: string; confirmationToken: string };
const pendingSchema = z.object({ outcome: z.enum(['pending', 'prepared']), expiresAt: z.iso.datetime() }).strict();
const completedSchema = z
  .object({ outcome: z.literal('completed'), operationKey: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
function fragment(): Confirmation | null {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  if (
    Array.from(parameters.keys()).length !== 2 ||
    parameters.getAll('operation').length !== 1 ||
    parameters.getAll('token').length !== 1
  )
    return null;
  const operationKey = parameters.get('operation') ?? '';
  const confirmationToken = parameters.get('token') ?? '';
  return /^[a-f0-9]{64}$/.test(operationKey) && /^[A-Za-z0-9_-]{43}$/.test(confirmationToken)
    ? { operationKey, confirmationToken }
    : null;
}
export default function ConfirmFirstPasswordContent() {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<
    'checking' | 'ready' | 'saving' | 'completed' | 'invalid' | 'changed' | 'unavailable'
  >('checking');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [invalidPassword, setInvalidPassword] = useState(false);
  const link = useRef<Confirmation | null | undefined>(undefined);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (link.current === undefined) link.current = fragment();
    const confirmation = link.current;
    const attempt = new AbortController();
    if (!confirmation) {
      setState('invalid');
      return;
    }
    if (!publicFirstPasswordReady()) {
      setState('unavailable');
      return;
    }
    pending.current = attempt;
    void (async () => {
      try {
        const result = await fetch('/api/internal/auth/first-password/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          signal: attempt.signal,
          body: JSON.stringify({ operationKey: confirmation.operationKey }),
        });
        const reply: unknown = await result.json();
        if (attempt.signal.aborted) return;
        if (result.status === 401 || result.status === 409) {
          setState('changed');
          return;
        }
        if (result.status === 400) {
          setState('invalid');
          return;
        }
        const parsed = pendingSchema.safeParse(reply);
        if (!result.ok || !parsed.success) {
          setState('unavailable');
          return;
        }
        setState(Date.parse(parsed.data.expiresAt) > Date.now() ? 'ready' : 'invalid');
      } catch {
        if (!attempt.signal.aborted) setState('unavailable');
      } finally {
        if (pending.current === attempt) pending.current = null;
      }
    })();
    return () => {
      attempt.abort();
      pending.current?.abort();
    };
  }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state !== 'ready' || !link.current || pending.current) return;
    if (password.length < 8 || password.length > 128 || password !== confirmPassword) {
      setInvalidPassword(true);
      return;
    }
    const confirmation = { ...link.current };
    const attempt = new AbortController();
    pending.current = attempt;
    setState('saving');
    setInvalidPassword(false);
    try {
      const result = await fetch('/api/internal/auth/first-password/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: attempt.signal,
        body: JSON.stringify({ ...confirmation, password, confirmPassword }),
      });
      const reply: unknown = await result.json();
      if (attempt.signal.aborted) return;
      if (result.status === 401 || result.status === 409) {
        setState('changed');
        return;
      }
      if (result.status === 400) {
        setState('invalid');
        return;
      }
      const parsed = completedSchema.safeParse(reply);
      if (!result.ok || !parsed.success || parsed.data.operationKey !== confirmation.operationKey) {
        setState('unavailable');
        return;
      }
      link.current = null;
      setPassword('');
      setConfirmPassword('');
      setState('completed');
    } catch {
      if (!attempt.signal.aborted) setState('unavailable');
    } finally {
      if (pending.current === attempt) pending.current = null;
    }
  };
  return (
    <Box component="main" sx={{ maxWidth: 600, mx: 'auto', p: 3 }}>
      <Card>
        <CardContent>
          <Typography variant="h1">{t('firstPassword.title')}</Typography>
          {state === 'checking' && <Typography>{t('firstPassword.checking')}</Typography>}
          {state === 'completed' && <Alert severity="success">{t('firstPassword.completed')}</Alert>}
          {state === 'invalid' && <Alert severity="error">{t('firstPassword.invalid')}</Alert>}
          {state === 'changed' && <Alert severity="info">{t('firstPassword.changed')}</Alert>}
          {state === 'unavailable' && <Alert severity="error">{t('firstPassword.unavailable')}</Alert>}
          {(state === 'ready' || state === 'saving') && (
            <Box component="form" onSubmit={submit} sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 2 }}>
              <Typography>{t('firstPassword.confirmDescription')}</Typography>
              <TextField
                label={t('password.passwordLabel')}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={state === 'saving'}
                error={invalidPassword}
                inputProps={{ maxLength: 128 }}
              />
              <TextField
                label={t('password.confirmLabel')}
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={state === 'saving'}
                error={invalidPassword}
                helperText={invalidPassword ? t('firstPassword.passwordMismatch') : undefined}
                inputProps={{ maxLength: 128 }}
              />
              <Button variant="contained" type="submit" disabled={state === 'saving'}>
                {state === 'saving' ? t('firstPassword.saving') : t('password.submit')}
              </Button>
            </Box>
          )}
          <Button component={LocaleLink} href="/settings" sx={{ mt: 2 }}>
            {t('firstPassword.settings')}
          </Button>
        </CardContent>
      </Card>
    </Box>
  );
}
