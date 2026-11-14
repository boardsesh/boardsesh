'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { getCsrfToken } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { readCanonicalBrowserCoordinator } from '@/app/lib/auth/browser-coordinator-client';
import { publicBrowserCoordinatorReady } from '@/app/lib/auth/browser-coordinator-readiness';
import { publicProviderSecurityReady } from '@/app/lib/auth/provider-security-readiness';
import { startCanonicalProviderSignin } from '@/app/lib/auth/canonical-provider-start';

const ALLOWED_PROVIDERS = new Set(['google', 'apple']);

function NativeStartInner({ canonicalAuthOrigin }: { canonicalAuthOrigin: string | null }) {
  const { t } = useTranslation('auth');
  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  const currentAttempt = useRef<AbortController | null>(null);
  const [failed, setFailed] = useState(false);
  const provider = params.get('provider');
  const callbackUrl = params.get('callbackUrl') ?? '/';

  useEffect(() => {
    if (submitted.current || currentAttempt.current) return;
    if (!provider || !ALLOWED_PROVIDERS.has(provider)) return;
    const controller = new AbortController();
    currentAttempt.current = controller;
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const prepareAttribution = async () => {
      if (controller.signal.aborted) return;
      try {
        const callback = new URL(callbackUrl, window.location.origin);
        const attemptId = callback.searchParams.get('attemptId');
        if (
          callback.origin === window.location.origin &&
          callback.pathname === '/api/auth/native/callback' &&
          attemptId &&
          /^[0-9a-f]{32}$/.test(attemptId) &&
          (provider === 'apple' || provider === 'google')
        ) {
          const attribution = new AbortController();
          const stop = () => attribution.abort();
          controller.signal.addEventListener('abort', stop, { once: true });
          const attributionTimeout = setTimeout(stop, 3000);
          try {
            const response = await fetch('/api/auth/native/attempt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ attemptId, provider }),
              credentials: 'same-origin',
              signal: attribution.signal,
            });
            await response.arrayBuffer();
          } finally {
            clearTimeout(attributionTimeout);
            controller.signal.removeEventListener('abort', stop);
          }
        }
      } catch {
        // Missing attribution proof must never block the OAuth fallback.
      }
    };
    void (async () => {
      const coordinatorReady = publicBrowserCoordinatorReady();
      const providerReady = publicProviderSecurityReady();
      if (coordinatorReady || providerReady) {
        if (
          !coordinatorReady ||
          !providerReady ||
          !canonicalAuthOrigin ||
          (provider !== 'google' && provider !== 'apple')
        )
          throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
        await startCanonicalProviderSignin(
          { canonicalOrigin: canonicalAuthOrigin, provider, callbackUrl, signal: controller.signal },
          {
            currentOrigin: window.location.origin,
            locks: navigator.locks,
            preflight: readCanonicalBrowserCoordinator,
            send: fetch,
            beforeSignin: prepareAttribution,
            navigate: (destination) => {
              if (!active || controller.signal.aborted) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
              submitted.current = true;
              window.location.assign(destination);
            },
          },
        );
        return;
      }
      await prepareAttribution();
      if (!active) return;
      if (controller.signal.aborted) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
      const csrfToken = await getCsrfToken();
      if (!active || submitted.current) return;
      if (controller.signal.aborted) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
      if (!csrfToken || !formRef.current) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
      submitted.current = true;

      const input = formRef.current.querySelector<HTMLInputElement>('input[name="csrfToken"]');
      if (input) input.value = csrfToken;
      formRef.current.submit();
    })()
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (currentAttempt.current === controller) currentAttempt.current = null;
      });
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
      if (currentAttempt.current === controller) currentAttempt.current = null;
    };
  }, [provider, callbackUrl, canonicalAuthOrigin]);

  if (!provider || !ALLOWED_PROVIDERS.has(provider)) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
        }}
      >
        <Typography>{t('nativeStart.invalidProvider')}</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 2,
      }}
    >
      {failed ? (
        <>
          <Typography>{t('nativeStart.oauthError')}</Typography>
          <Button variant="contained" onClick={() => window.location.reload()}>
            {t('nativeStart.retryProviders')}
          </Button>
        </>
      ) : (
        <>
          <CircularProgress />
          <Typography>{t('nativeStart.signingIn')}</Typography>
        </>
      )}
      <form ref={formRef} method="POST" action={`/api/auth/signin/${encodeURIComponent(provider)}`} hidden>
        <input type="hidden" name="csrfToken" value="" />
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
      </form>
    </Box>
  );
}

export default function NativeStartClient({ canonicalAuthOrigin = null }: { canonicalAuthOrigin?: string | null }) {
  return (
    <Suspense
      fallback={
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
          }}
        >
          <CircularProgress />
        </Box>
      }
    >
      <NativeStartInner canonicalAuthOrigin={canonicalAuthOrigin} />
    </Suspense>
  );
}
