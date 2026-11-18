'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { refreshAccessTokenAfterCredentialChange } from '@/app/lib/auth/browser-access-token';
import {
  PROVIDER_SECURITY_PATH,
  PROVIDER_SECURITY_RESULT_PARAM,
  answerStatus,
  postAccountSecurity,
  readAccountSecurity,
  refusalOf,
  type AccountSecurityAnswer,
} from '@/app/lib/auth/account-security-client';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { DEFAULT_LOCALE, isSupportedLocale } from '@/app/lib/i18n/config';

type Provider = 'google' | 'apple';
type LinkedMethod = { methodId: string; provider: Provider; canUnlink: boolean };
type Methods = {
  passwordUsable: boolean;
  providers: LinkedMethod[];
  reauthentication: { password: boolean; google: boolean };
  linking: Record<Provider, { available: boolean; reason?: string }>;
};
type Flow = { action: 'link' | 'unlink'; provider: Provider };

const PROVIDER_NAMES: Record<Provider, string> = { google: 'Google', apple: 'Apple' };
/**
 * The copy of each result is looked up by its value:
 * i18n-keep settings:signInMethods.results.linked
 * i18n-keep settings:signInMethods.results.unlinked
 * i18n-keep settings:signInMethods.results.cancelled
 * i18n-keep settings:signInMethods.results.expired
 * i18n-keep settings:signInMethods.results.state_mismatch
 * i18n-keep settings:signInMethods.results.session_required
 * i18n-keep settings:signInMethods.results.identity_changed
 * i18n-keep settings:signInMethods.results.provider_not_verified
 * i18n-keep settings:signInMethods.results.unavailable
 * i18n-keep settings:signInMethods.results.reauthentication_required
 * i18n-keep settings:signInMethods.results.last_usable_method
 * i18n-keep settings:signInMethods.results.ownership_conflict
 * i18n-keep settings:signInMethods.results.too_many_pending
 * i18n-keep settings:signInMethods.results.provider_unavailable
 * i18n-keep settings:signInMethods.results.replayed
 * i18n-keep settings:signInMethods.results.failed
 */
/** Results of a provider round trip, and refusal codes, that have their own copy; anything else is the generic one. */
const KNOWN_RESULTS = new Set([
  'linked',
  'unlinked',
  'cancelled',
  'expired',
  'state_mismatch',
  'session_required',
  'identity_changed',
  'provider_not_verified',
  'unavailable',
  'reauthentication_required',
  'last_usable_method',
  'ownership_conflict',
  'too_many_pending',
  'provider_unavailable',
  'replayed',
]);

function methodsOf(answer: AccountSecurityAnswer): Methods | undefined {
  if (answer.httpStatus !== 200 || answerStatus(answer) !== 'methods') return undefined;
  const { passwordUsable, providers, reauthentication, linking } = answer.body;
  if (typeof passwordUsable !== 'boolean' || !Array.isArray(providers) || !reauthentication || !linking)
    return undefined;
  return { passwordUsable, providers, reauthentication, linking } as Methods;
}

/**
 * Settings card "Sign-in methods" under `AUTH_BROWSER_SESSION_MODE=better-auth`
 * (#7596 B5e2): the password state and the linked Google and Apple
 * identities, with connect and disconnect on www's provider-security routes.
 * Each change asks for the password, or a fresh Google sign-in, first. A
 * change keeps this browser signed in (same session, new generation): the
 * page fetches a new access token and every other device signs in again.
 */
export default function SignInMethodsSection() {
  const { t, i18n } = useTranslation('settings');
  const locale = isSupportedLocale(i18n?.language) ? i18n.language : DEFAULT_LOCALE;
  const { showMessage } = useSnackbar();
  const passwordId = useId();
  const [methods, setMethods] = useState<Methods | 'failed'>();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [pendingBlocked, setPendingBlocked] = useState(false);

  const resultText = useCallback(
    (result: string, provider?: Provider) =>
      t(`signInMethods.results.${KNOWN_RESULTS.has(result) ? result : 'failed'}`, {
        provider: provider ? PROVIDER_NAMES[provider] : '',
      }),
    [t],
  );

  const load = useCallback(async () => {
    try {
      setMethods(methodsOf(await readAccountSecurity(`${PROVIDER_SECURITY_PATH}/methods`)) ?? 'failed');
    } catch {
      setMethods('failed');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Google or Apple: say how it went, once, then take the value out of the address.
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    handledReturn.current = true;
    const url = new URL(window.location.href);
    const result = url.searchParams.get(PROVIDER_SECURITY_RESULT_PARAM);
    if (result === null) return;
    const provider = url.searchParams.get('provider');
    url.searchParams.delete(PROVIDER_SECURITY_RESULT_PARAM);
    url.searchParams.delete('provider');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (result === 'identity_changed') {
      window.location.assign(localeHref('/', locale));
      return;
    }
    if (result === 'linked' || result === 'unlinked') void refreshAccessTokenAfterCredentialChange();
    showMessage(
      resultText(result, provider === 'google' || provider === 'apple' ? provider : undefined),
      result === 'linked' || result === 'unlinked' ? 'success' : 'error',
    );
  }, [locale, resultText, showMessage]);

  /** What every step's answer does: done, off to the provider, try again, or one `recover`. */
  const settle = useCallback(
    async (answer: AccountSecurityAnswer, active: Flow, recovering = false): Promise<void> => {
      const status = answerStatus(answer);
      if (status === 'committed') {
        setFlow(null);
        setPassword('');
        void refreshAccessTokenAfterCredentialChange();
        showMessage(resultText(active.action === 'link' ? 'linked' : 'unlinked', active.provider), 'success');
        await load();
        return;
      }
      if (status === 'redirect' && typeof answer.body.url === 'string') {
        window.location.assign(answer.body.url);
        return;
      }
      if (status === 'unavailable' && !recovering) {
        // A lost reply may have committed: ask once.
        await settle(await postAccountSecurity(`${PROVIDER_SECURITY_PATH}/recover`), active, true);
        return;
      }
      const refusal = refusalOf(answer);
      // Nothing to recover: the step itself did not go through (the backend answers 503 past five
      // reauthentication tries a minute). The flow stays open for another try in a minute.
      if (recovering && (status === 'unavailable' || refusal?.code === 'invalid_intent')) {
        setFlowError(t('signInMethods.tryAgainSoon'));
        return;
      }
      if (refusal?.outcome === 'identity_changed') {
        window.location.assign(localeHref('/', locale));
        return;
      }
      // A wrong password keeps the flow open for another try.
      if (refusal?.outcome === 'reauthentication_required' && refusal.code !== 'expired') {
        setFlowError(t('signInMethods.wrongPassword'));
        return;
      }
      // The route ended this flow (and gave its intent back).
      setFlow(null);
      setFlowError(null);
      showMessage(resultText(refusal?.code ?? 'failed', active.provider), 'error');
      await load();
    },
    [load, locale, resultText, showMessage, t],
  );

  async function run(step: () => Promise<AccountSecurityAnswer>, active: Flow) {
    setPending(true);
    setFlowError(null);
    try {
      await settle(await step(), active);
    } catch {
      setFlowError(t('signInMethods.tryAgainSoon'));
    } finally {
      setPending(false);
    }
  }

  /** Gives back this browser's open change, the way out of `too_many_pending`. */
  async function cancelPending() {
    setPending(true);
    try {
      await postAccountSecurity(`${PROVIDER_SECURITY_PATH}/abort`);
    } catch {
      // Whatever is still waiting ends on its own within 15 minutes.
    } finally {
      setPendingBlocked(false);
      setPending(false);
      showMessage(t('signInMethods.pendingCancelled'), 'info');
    }
  }

  async function begin(next: Flow, methodId?: string) {
    setPending(true);
    setFlowError(null);
    try {
      const answer = await postAccountSecurity(`${PROVIDER_SECURITY_PATH}/start`, {
        action: next.action,
        provider: next.provider,
        ...(methodId ? { methodId } : {}),
        returnTo: `${window.location.pathname}${window.location.search}`,
      });
      const status = answerStatus(answer);
      if (status === 'reauthentication_required') setFlow(next);
      else if (refusalOf(answer)?.code === 'too_many_pending') setPendingBlocked(true);
      else if (status === 'unavailable') showMessage(t('signInMethods.tryAgainSoon'), 'error');
      else if (refusalOf(answer)?.outcome === 'identity_changed') window.location.assign(localeHref('/', locale));
      else showMessage(resultText(refusalOf(answer)?.code ?? 'failed', next.provider), 'error');
    } catch {
      showMessage(t('signInMethods.tryAgainSoon'), 'error');
    } finally {
      setPending(false);
    }
  }

  if (methods === undefined)
    return (
      <Card>
        <CardContent sx={{ display: 'flex', justifyContent: 'center' }}>
          <CircularProgress size={32} />
        </CardContent>
      </Card>
    );
  if (methods === 'failed')
    return (
      <Card>
        <CardContent>
          <Typography variant="h5">{t('signInMethods.title')}</Typography>
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => void load()}>
                {t('signInMethods.retry')}
              </Button>
            }
          >
            {t('signInMethods.loadFailed')}
          </Alert>
        </CardContent>
      </Card>
    );

  const linked = (provider: Provider) => methods.providers.find((method) => method.provider === provider);
  // With neither a password nor a usable Google there is no way to confirm a change yet.
  const canConfirm = methods.reauthentication.password || methods.reauthentication.google;
  const shownProviders = (['google', 'apple'] as const).filter(
    (provider) => linked(provider) || methods.linking[provider]?.reason !== 'not_configured',
  );

  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{t('signInMethods.title')}</Typography>
        <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {t('signInMethods.description')}
        </Typography>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
            <Typography>{t('signInMethods.password')}</Typography>
            <Typography color="text.secondary">
              {methods.passwordUsable ? t('signInMethods.passwordSet') : t('signInMethods.passwordNotSet')}
            </Typography>
          </Box>
          {shownProviders.map((provider) => {
            const method = linked(provider);
            const name = PROVIDER_NAMES[provider];
            return (
              <Box key={provider}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                  <Typography>{name}</Typography>
                  {method ? (
                    <Button
                      variant="outlined"
                      size="small"
                      aria-label={t('signInMethods.disconnectProvider', { provider: name })}
                      disabled={pending || flow !== null || !method.canUnlink || !canConfirm}
                      onClick={() => void begin({ action: 'unlink', provider }, method.methodId)}
                    >
                      {t('signInMethods.disconnect')}
                    </Button>
                  ) : methods.linking[provider]?.available ? (
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={pending || flow !== null || !canConfirm}
                      onClick={() => void begin({ action: 'link', provider })}
                    >
                      {t('signInMethods.connect', { provider: name })}
                    </Button>
                  ) : (
                    <Typography color="text.secondary">{t('signInMethods.notAvailableYet')}</Typography>
                  )}
                </Box>
                {method && !method.canUnlink && (
                  <Typography variant="body2" color="text.secondary">
                    {t('signInMethods.onlyMethod')}
                  </Typography>
                )}
              </Box>
            );
          })}
          {pendingBlocked && (
            <Alert
              severity="warning"
              action={
                <Button color="inherit" size="small" disabled={pending} onClick={() => void cancelPending()}>
                  {t('signInMethods.cancelPending')}
                </Button>
              }
            >
              {t('signInMethods.results.too_many_pending')}
            </Alert>
          )}
          {!methods.passwordUsable && (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" component={LocaleLink} href="/settings/first-password">
                  {t('signInMethods.setPassword')}
                </Button>
              }
            >
              {t('signInMethods.noPassword')}
            </Alert>
          )}
          {flow && (
            <Box sx={{ borderTop: '1px solid var(--neutral-200)', pt: 2 }}>
              <Typography sx={{ mb: 2 }}>
                {t(flow.action === 'link' ? 'signInMethods.confirmLink' : 'signInMethods.confirmUnlink', {
                  provider: PROVIDER_NAMES[flow.provider],
                })}
              </Typography>
              {flowError && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {flowError}
                </Alert>
              )}
              <Stack spacing={2}>
                {methods.reauthentication.password && (
                  <Box
                    component="form"
                    onSubmit={(event: React.FormEvent) => {
                      event.preventDefault();
                      if (password)
                        void run(
                          () => postAccountSecurity(`${PROVIDER_SECURITY_PATH}/reauthenticate/password`, { password }),
                          flow,
                        );
                    }}
                  >
                    <Stack spacing={2}>
                      <TextField
                        id={passwordId}
                        type="password"
                        label={t('signInMethods.passwordLabel')}
                        autoComplete="current-password"
                        size="small"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        fullWidth
                      />
                      <Button type="submit" variant="contained" disabled={pending || !password} fullWidth>
                        {t('signInMethods.confirm')}
                      </Button>
                    </Stack>
                  </Box>
                )}
                {methods.reauthentication.google && (
                  <Button
                    variant="outlined"
                    disabled={pending}
                    fullWidth
                    onClick={() =>
                      void run(() => postAccountSecurity(`${PROVIDER_SECURITY_PATH}/reauthenticate/google`), flow)
                    }
                  >
                    {t('signInMethods.continueWithGoogle')}
                  </Button>
                )}
                <Button
                  variant="text"
                  disabled={pending}
                  onClick={() => {
                    setFlow(null);
                    setFlowError(null);
                    void postAccountSecurity(`${PROVIDER_SECURITY_PATH}/abort`).catch(() => undefined);
                  }}
                >
                  {t('signInMethods.cancel')}
                </Button>
              </Stack>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
