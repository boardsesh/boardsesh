'use client';

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import MuiLink from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';

export type AccountProvider = 'google' | 'apple';
export interface AccountProviderMethod {
  readonly methodId: string;
  readonly provider: AccountProvider;
  readonly usable: boolean;
  readonly canUnlink: boolean;
}
export type ProviderMethodAction =
  | { readonly action: 'link'; readonly provider: AccountProvider }
  | { readonly action: 'unlink'; readonly provider: AccountProvider; readonly methodId: string };
export type ProviderMethodOutcome =
  | 'completed'
  | 'redirecting'
  | 'reauthentication_required'
  | 'reauthentication_unavailable'
  | 'identity_changed'
  | 'last_usable_method'
  | 'ownership_conflict'
  | 'unavailable';
export interface ProviderMethodResult {
  readonly outcome: ProviderMethodOutcome;
}
export type ProviderReauthentication =
  | { readonly method: 'password'; readonly password: string }
  | { readonly method: 'google' };
export interface ProviderMethodsSectionProps {
  /** Opaque UI scope; change on account, SID, generation or binding-version change.
   * This key never authorizes an action; the owning broker re-admits its actor. */
  readonly actorContextKey: string;
  readonly methods: readonly AccountProviderMethod[];
  readonly configuredProviders: readonly AccountProvider[];
  readonly passwordUsable: boolean;
  readonly googleReauthenticationAvailable: boolean;
  readonly passwordSetupHref?: string;
  readonly recoveryHref?: string;
  readonly onAction: (action: ProviderMethodAction) => Promise<ProviderMethodResult>;
  readonly onReauthenticate: (method: ProviderReauthentication) => Promise<ProviderMethodResult>;
  /** Restored only from the actor-bound server resume reader. */
  readonly resumeAction?: ProviderMethodAction;
}

/** Controlled view only. The owning broker verifies identity, freshness and
 * capabilities; this component performs no network or credential-cookie I/O. */
export default function ProviderMethodsSection({
  actorContextKey,
  methods,
  configuredProviders,
  passwordUsable,
  googleReauthenticationAvailable,
  passwordSetupHref,
  recoveryHref,
  onAction,
  onReauthenticate,
  resumeAction,
}: ProviderMethodsSectionProps) {
  const { t } = useTranslation('settings');
  const headingId = useId();
  const [pending, setPending] = useState<ProviderMethodAction | null>(null);
  const [phase, setPhase] = useState<'confirmation' | 'reauthentication'>('confirmation');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const working = useRef(false);
  const handlers = useRef<Pick<ProviderMethodsSectionProps, 'onAction' | 'onReauthenticate'> | null>(null);
  const methodBasis = JSON.stringify({ methods, configuredProviders, passwordUsable, googleReauthenticationAvailable });

  useLayoutEffect(() => {
    attempt.current += 1;
    working.current = false;
    handlers.current = null;
    setPending(null);
    setPassword('');
    setBusy(false);
    setNotice(null);
  }, [methodBasis, actorContextKey]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
    };
  }, []);
  useEffect(() => {
    if (!resumeAction) return;
    attempt.current += 1;
    working.current = false;
    handlers.current = { onAction, onReauthenticate };
    setPending({ ...resumeAction });
    setPhase('confirmation');
    setPassword('');
    setBusy(false);
    setNotice(null);
    setSuccess(false);
  }, [resumeAction, actorContextKey, onAction, onReauthenticate]);

  const providerName = (provider: AccountProvider) =>
    provider === 'google' ? t('providerMethods.providers.google') : t('providerMethods.providers.apple');
  const open = (action: ProviderMethodAction) => {
    attempt.current += 1;
    handlers.current = { onAction, onReauthenticate };
    setPending(action);
    setPhase('confirmation');
    setPassword('');
    setNotice(null);
    setSuccess(false);
  };
  const close = () => {
    if (working.current) return;
    attempt.current += 1;
    handlers.current = null;
    setPending(null);
    setPassword('');
    setNotice(null);
  };
  const outcomeNotice = (outcome: Exclude<ProviderMethodOutcome, 'completed' | 'redirecting'>) => {
    switch (outcome) {
      case 'reauthentication_required':
        return t('providerMethods.reauthenticationRequired');
      case 'reauthentication_unavailable':
        return t('providerMethods.reauthenticationUnavailable');
      case 'identity_changed':
        return t('providerMethods.identityChanged');
      case 'last_usable_method':
        return t('providerMethods.lastUsableMethod');
      case 'ownership_conflict':
        return t('providerMethods.ownershipConflict');
      case 'unavailable':
        return t('providerMethods.unavailable');
    }
  };
  const perform = async (reauthentication?: ProviderReauthentication) => {
    if (!pending || !handlers.current || working.current) return;
    // Keep the actor-bound broker callbacks that owned the confirmation.
    const ownedHandlers = handlers.current;
    const action = { ...pending };
    const ownedAttempt = ++attempt.current;
    working.current = true;
    setBusy(true);
    setNotice(null);
    setSuccess(false);
    const owns = () => mounted.current && ownedAttempt === attempt.current;
    try {
      let result: ProviderMethodResult;
      if (reauthentication) {
        // Keep no password in component state while the broker verifies it.
        setPassword('');
        result = await ownedHandlers.onReauthenticate(reauthentication);
        if (!owns()) return;
        if (result.outcome === 'completed') result = await ownedHandlers.onAction(action);
      } else result = await ownedHandlers.onAction(action);
      if (!owns()) return;
      if (result.outcome === 'completed') {
        setPending(null);
        setSuccess(true);
        setNotice(
          action.action === 'link'
            ? t('providerMethods.linkCompleted', { provider: providerName(action.provider) })
            : t('providerMethods.unlinkCompleted', { provider: providerName(action.provider) }),
        );
      } else if (result.outcome === 'redirecting') {
        setPending(null);
        setNotice(t('providerMethods.redirecting'));
      } else {
        if (result.outcome === 'reauthentication_required' || result.outcome === 'reauthentication_unavailable')
          setPhase('reauthentication');
        if (result.outcome === 'identity_changed') setPending(null);
        setNotice(outcomeNotice(result.outcome));
      }
    } catch {
      if (owns()) setNotice(t('providerMethods.unavailable'));
    } finally {
      if (owns()) {
        working.current = false;
        setBusy(false);
        setPassword('');
      }
    }
  };
  const activeMethods = methods.filter((method) => method.provider === 'google' || method.provider === 'apple');
  const availableProviders = (['google', 'apple'] as const).filter(
    (provider) =>
      configuredProviders.includes(provider) && !activeMethods.some((method) => method.provider === provider),
  );
  const noReauthentication = !passwordUsable && !googleReauthenticationAvailable;

  return (
    <Card component="section" aria-labelledby={headingId}>
      <CardContent>
        <Stack spacing={2}>
          <Typography id={headingId} variant="h6">
            {t('providerMethods.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('providerMethods.description')}
          </Typography>
          {activeMethods.map((method) => (
            <Stack key={method.methodId} direction="row" spacing={2} alignItems="center" justifyContent="space-between">
              <Box>
                <Typography>{providerName(method.provider)}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {method.usable ? t('providerMethods.usable') : t('providerMethods.notUsable')}
                </Typography>
                {!method.canUnlink && (
                  <Typography variant="body2" color="text.secondary">
                    {t('providerMethods.lastUsableMethod')}
                  </Typography>
                )}
              </Box>
              <Button
                disabled={busy || !method.canUnlink}
                onClick={() => open({ action: 'unlink', provider: method.provider, methodId: method.methodId })}
              >
                {t('providerMethods.unlink', { provider: providerName(method.provider) })}
              </Button>
            </Stack>
          ))}
          {availableProviders.map((provider) => (
            <Button
              key={provider}
              variant="outlined"
              disabled={busy}
              onClick={() => open({ action: 'link', provider })}
            >
              {t('providerMethods.link', { provider: providerName(provider) })}
            </Button>
          ))}
          {activeMethods.length === 0 && availableProviders.length === 0 && (
            <Typography color="text.secondary">{t('providerMethods.noProviders')}</Typography>
          )}
          {notice && !pending && <Alert severity={success ? 'success' : 'info'}>{notice}</Alert>}
        </Stack>
      </CardContent>
      <Dialog open={pending !== null} onClose={close} fullWidth maxWidth="sm" aria-labelledby={`${headingId}-dialog`}>
        <DialogTitle id={`${headingId}-dialog`}>
          {phase === 'confirmation' ? t('providerMethods.confirmTitle') : t('providerMethods.reauthenticationTitle')}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            {phase === 'confirmation' ? (
              <>
                <DialogContentText>
                  {pending?.action === 'link'
                    ? t('providerMethods.confirmLink', { provider: providerName(pending.provider) })
                    : t('providerMethods.confirmUnlink', { provider: pending ? providerName(pending.provider) : '' })}
                </DialogContentText>
                <DialogContentText>{t('providerMethods.securityEffects')}</DialogContentText>
              </>
            ) : (
              <>
                <DialogContentText>{t('providerMethods.reauthenticationDescription')}</DialogContentText>
                {passwordUsable && (
                  <Box
                    component="form"
                    onSubmit={(event: React.FormEvent) => {
                      event.preventDefault();
                      if (password) void perform({ method: 'password', password });
                    }}
                  >
                    <Stack spacing={2}>
                      <TextField
                        label={t('providerMethods.password')}
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        disabled={busy}
                        fullWidth
                      />
                      <Button type="submit" variant="contained" disabled={busy || !password}>
                        {t('providerMethods.verifyPassword')}
                      </Button>
                    </Stack>
                  </Box>
                )}
                {googleReauthenticationAvailable && (
                  <Button disabled={busy} variant="outlined" onClick={() => void perform({ method: 'google' })}>
                    {t('providerMethods.verifyGoogle')}
                  </Button>
                )}
                {noReauthentication && notice !== t('providerMethods.reauthenticationUnavailable') && (
                  <Alert severity="info">{t('providerMethods.reauthenticationUnavailable')}</Alert>
                )}
                {passwordSetupHref && (
                  <MuiLink component={LocaleLink} href={passwordSetupHref}>
                    {t('providerMethods.passwordOptions')}
                  </MuiLink>
                )}
                {recoveryHref && (
                  <MuiLink component={LocaleLink} href={recoveryHref}>
                    {t('providerMethods.recovery')}
                  </MuiLink>
                )}
                {(passwordSetupHref || recoveryHref) && (
                  <Typography variant="body2" color="text.secondary">
                    {t('providerMethods.recoveryNotProof')}
                  </Typography>
                )}
              </>
            )}
            {notice && <Alert severity="warning">{notice}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={close}>
            {t('providerMethods.cancel')}
          </Button>
          {phase === 'confirmation' && (
            <Button disabled={busy} variant="contained" onClick={() => void perform()}>
              {t('providerMethods.confirm')}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Card>
  );
}
