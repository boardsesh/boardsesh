'use client';
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Session } from 'next-auth';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import ProviderMethodsSection, {
  type ProviderMethodAction,
  type ProviderReauthentication,
  type ProviderMethodResult,
} from './provider-methods-section';
import { createProviderSettingsClient, type ProviderSettingsMethods } from '@/app/lib/auth/provider-security-client';
import { publicProviderSecurityReady } from '@/app/lib/auth/provider-security-readiness';
import { browserBackendClient } from '@/app/lib/auth/browser-backend-client';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';

const unavailable = (): Promise<ProviderMethodResult> => Promise.resolve({ outcome: 'unavailable' });
const serverSnapshot = () => null;
function operationInUrl(): string | null {
  const selectors = new URL(window.location.href).searchParams.getAll('providerSecurityResume');
  if (selectors.length === 0) return null;
  if (selectors.length !== 1 || !/^[a-f0-9]{64}$/.test(selectors[0]))
    throw new Error('Invalid provider resume selector');
  return selectors[0];
}
function retainOperation(operationKey: string | null): void {
  const url = new URL(window.location.href);
  if (operationKey === null) url.searchParams.delete('providerSecurityResume');
  else url.searchParams.set('providerSecurityResume', operationKey);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}
export default function ProviderSettingsController({ session }: { readonly session: Session | null }) {
  if (!publicProviderSecurityReady()) return null;
  const selected = readBrowserBackendSessionScope(session);
  if (selected.status !== 'selected' || session === null) return null;
  return <OwnedProviderSettingsController key={browserBackendSessionKey(selected.owner)} session={session} />;
}
function OwnedProviderSettingsController({ session }: { readonly session: Session }) {
  const { t, i18n } = useTranslation('settings');
  const locale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  useSyncExternalStore(browserBackendClient.subscribe, browserBackendClient.getSnapshot, serverSnapshot);
  const [methods, setMethods] = useState<ProviderSettingsMethods | null>(null);
  const [resumeAction, setResumeAction] = useState<ProviderMethodAction | undefined>();
  const [notice, setNotice] = useState<'unavailable' | 'completed' | null>(null);
  const controller = useRef<ReturnType<typeof createProviderSettingsClient> | null>(null);
  useLayoutEffect(() => {
    const client = createProviderSettingsClient({
      session,
      locale,
      canonicalOrigin: window.location.origin,
      onOperation: retainOperation,
    });
    controller.current = client;
    setMethods(null);
    setResumeAction(undefined);
    setNotice(null);
    void (async () => {
      let available: ProviderSettingsMethods | null = null;
      try {
        available = await client.readMethods();
        if (!client.isCurrent()) return;
        const operationKey = operationInUrl();
        if (operationKey !== null) {
          const resumed = await client.resume(operationKey);
          if (!client.isCurrent()) return;
          if (resumed.status === 'completed') setNotice('completed');
          else
            setResumeAction(
              resumed.metadata.action === 'link'
                ? { action: 'link', provider: resumed.metadata.provider }
                : { action: 'unlink', provider: resumed.metadata.provider, methodId: resumed.metadata.methodId },
            );
        }
      } catch {
        if (client.isCurrent()) setNotice('unavailable');
      } finally {
        // A failed/expired operation must not hide independently admitted
        // current methods or prevent the user from confirming a fresh change.
        if (available && client.isCurrent()) setMethods(available);
      }
    })();
    return () => {
      client.dispose();
      if (controller.current === client) controller.current = null;
    };
  }, [session, locale]);
  const action = useCallback(
    (confirmed: ProviderMethodAction) => controller.current?.action(confirmed) ?? unavailable(),
    [],
  );
  const reauthenticate = useCallback(
    (proof: ProviderReauthentication) => controller.current?.reauthenticate(proof) ?? unavailable(),
    [],
  );
  if (!browserBackendClient.isSessionCurrent(session)) return null;
  if (!methods)
    return notice === 'unavailable' ? (
      <Alert severity="warning">{t('providerMethods.unavailable')}</Alert>
    ) : (
      <Box sx={{ py: 2 }}>
        <CircularProgress size={24} aria-label={t('providerMethods.loading')} />
      </Box>
    );
  return (
    <>
      {notice === 'unavailable' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('providerMethods.unavailable')}
        </Alert>
      )}
      {notice === 'completed' && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {t('providerMethods.resumeCompleted')}
        </Alert>
      )}
      <ProviderMethodsSection
        actorContextKey={methods.actorContextKey}
        methods={methods.methods}
        configuredProviders={methods.configuredProviders}
        passwordUsable={methods.passwordUsable}
        googleReauthenticationAvailable={methods.googleReauthenticationAvailable}
        recoveryHref={methods.passwordUsable ? '/auth/forgot-password' : undefined}
        onAction={action}
        onReauthenticate={reauthenticate}
        resumeAction={resumeAction}
      />
    </>
  );
}
