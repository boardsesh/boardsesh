'use client';

import React, { useEffect, useRef, useState } from 'react';
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
import LocaleLink from '@/app/components/i18n/locale-link';
import { refreshAccessTokenAfterCredentialChange } from '@/app/lib/auth/browser-access-token';
import {
  FIRST_PASSWORD_PATH,
  answerStatus,
  postAccountSecurity,
  refusalOf,
  type AccountSecurityAnswer,
} from '@/app/lib/auth/account-security-client';

/**
 * What the page shows. Every state but `form` and `done` has its own message:
 * i18n-keep auth:confirmFirstPassword.views.invalidLink
 * i18n-keep auth:confirmFirstPassword.views.otherBrowser
 * i18n-keep auth:confirmFirstPassword.views.otherAccount
 * i18n-keep auth:confirmFirstPassword.views.signedOut
 * i18n-keep auth:confirmFirstPassword.views.expired
 * i18n-keep auth:confirmFirstPassword.views.alreadySet
 * i18n-keep auth:confirmFirstPassword.views.tryAgainSoon
 */
type View =
  | 'checking'
  | 'form'
  | 'done'
  | 'invalidLink'
  | 'otherBrowser'
  | 'otherAccount'
  | 'signedOut'
  | 'expired'
  | 'alreadySet'
  | 'tryAgainSoon';
type Link = { token: string; operation: string };

/** The view a non-success answer leads to. */
function viewOf(answer: AccountSecurityAnswer): View {
  const status = answerStatus(answer);
  if (status === 'other_browser') return 'otherBrowser';
  if (status === 'other_account') return 'otherAccount';
  if (answer.httpStatus === 401) return 'signedOut';
  const code = refusalOf(answer)?.code;
  if (code === 'expired' || code === 'replayed') return 'expired';
  if (code === 'already_set' || code === 'not_eligible') return 'alreadySet';
  if (refusalOf(answer)?.outcome === 'identity_changed') return 'otherAccount';
  return 'tryAgainSoon';
}

/** The link's token and operation key, from the fragment, which is then taken out of the address. */
function takeLinkFromFragment(): Link | undefined {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('token');
  const operation = fragment.get('operation');
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  return token && operation && /^[A-Za-z0-9_-]{43}$/.test(token) && /^[a-f0-9]{64}$/.test(operation)
    ? { token, operation }
    : undefined;
}

export default function ConfirmFirstPasswordContent() {
  const { t } = useTranslation('auth');
  const [link, setLink] = useState<Link>();
  const [view, setView] = useState<View>('checking');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The fragment is read once: a second run (React Strict Mode) would find it gone.
  const linkTaken = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (linkTaken.current) return;
    linkTaken.current = true;
    const taken = takeLinkFromFragment();
    if (!taken) {
      setView('invalidLink');
      return;
    }
    setLink(taken);
    postAccountSecurity(`${FIRST_PASSWORD_PATH}/status`, { operation: taken.operation })
      .then((answer) => setView(answerStatus(answer) === 'pending' ? 'form' : viewOf(answer)))
      .catch(() => setView('tryAgainSoon'));
  }, []);

  async function finish(answer: AccountSecurityAnswer, recovering = false): Promise<void> {
    const status = answerStatus(answer);
    if (status === 'committed') {
      // The account's generation moved: this browser keeps its session and needs a new access token.
      void refreshAccessTokenAfterCredentialChange();
      setView('done');
      return;
    }
    if (status === 'invalid_password') return setFieldError(t('confirmFirstPassword.tooShort'));
    if (status === 'password_mismatch') return setFieldError(t('confirmFirstPassword.mismatch'));
    if (status === 'unavailable' && !recovering && link)
      // A lost reply may have committed: ask once.
      return finish(await postAccountSecurity(`${FIRST_PASSWORD_PATH}/recover`, { operation: link.operation }), true);
    // Nothing to recover (the step itself did not go through): keep the form for another try.
    if (recovering && (status === 'unavailable' || refusalOf(answer)?.code === 'invalid_proof'))
      return setFieldError(t('confirmFirstPassword.views.tryAgainSoon'));
    setView(viewOf(answer));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!link || pending) return;
    if (password.length < 8 || password.length > 128) return setFieldError(t('confirmFirstPassword.tooShort'));
    if (password !== confirmPassword) return setFieldError(t('confirmFirstPassword.mismatch'));
    setFieldError(null);
    setPending(true);
    try {
      await finish(await postAccountSecurity(`${FIRST_PASSWORD_PATH}/confirm`, { ...link, password, confirmPassword }));
    } catch {
      setView('tryAgainSoon');
    } finally {
      setPending(false);
    }
  }

  const message =
    view === 'checking' || view === 'form' || view === 'done' ? undefined : t(`confirmFirstPassword.views.${view}`);
  // When a result replaces the form, move focus to it so a screen reader hears it.
  useEffect(() => {
    if (view !== 'checking' && view !== 'form') resultRef.current?.focus();
  }, [view]);
  return (
    <Box component="main" sx={{ padding: '24px', display: 'flex', justifyContent: 'center', paddingTop: '48px' }}>
      <Card sx={{ width: '100%', maxWidth: 400 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h3" component="h1">
              {t('confirmFirstPassword.title')}
            </Typography>
            {view === 'checking' && <CircularProgress size={32} sx={{ alignSelf: 'center' }} />}
            <Box ref={resultRef} tabIndex={-1} sx={{ outline: 'none' }}>
              {message && <Alert severity={view === 'tryAgainSoon' ? 'error' : 'info'}>{message}</Alert>}
              {view === 'done' && <Alert severity="success">{t('confirmFirstPassword.done')}</Alert>}
            </Box>
            {view === 'form' && (
              <Box component="form" onSubmit={submit}>
                <Stack spacing={2}>
                  <Typography>{t('confirmFirstPassword.description')}</Typography>
                  {fieldError && <Alert severity="error">{fieldError}</Alert>}
                  <TextField
                    type="password"
                    label={t('confirmFirstPassword.passwordLabel')}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    fullWidth
                  />
                  <TextField
                    type="password"
                    label={t('confirmFirstPassword.confirmLabel')}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    fullWidth
                  />
                  <Button type="submit" variant="contained" disabled={pending} fullWidth>
                    {t('confirmFirstPassword.submit')}
                  </Button>
                </Stack>
              </Box>
            )}
            {view !== 'checking' && view !== 'form' && (
              <Button variant="text" component={LocaleLink} href="/settings">
                {t('confirmFirstPassword.toSettings')}
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}
