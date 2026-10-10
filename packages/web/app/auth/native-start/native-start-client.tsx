'use client';

import { useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { getCsrfToken } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

const ALLOWED_PROVIDERS = new Set(['google', 'apple', 'facebook']);

function NativeStartInner() {
  const { t } = useTranslation('auth');
  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);
  const preparing = useRef(false);
  const provider = params.get('provider');
  const callbackUrl = params.get('callbackUrl') ?? '/';

  useEffect(() => {
    if (submitted.current || preparing.current) return;
    if (!provider || !ALLOWED_PROVIDERS.has(provider)) return;
    preparing.current = true;

    const prepareAttempt = async () => {
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
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          try {
            await fetch('/api/auth/native/attempt', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ attemptId, provider }),
              credentials: 'same-origin',
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
        }
      } catch {
        // Missing attribution proof must never block the OAuth fallback.
      }
      return getCsrfToken();
    };
    void prepareAttempt()
      .then((csrfToken: string | undefined) => {
        if (!csrfToken || !formRef.current || submitted.current) return;
        submitted.current = true;

        const input = formRef.current.querySelector<HTMLInputElement>('input[name="csrfToken"]');
        if (input) input.value = csrfToken;
        formRef.current.submit();
      })
      .finally(() => {
        preparing.current = false;
      });
  }, [provider, callbackUrl]);

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
      <CircularProgress />
      <Typography>{t('nativeStart.signingIn')}</Typography>
      <form
        ref={formRef}
        method="POST"
        action={`/api/auth/signin/${encodeURIComponent(provider)}`}
        style={{ display: 'none' }}
      >
        <input type="hidden" name="csrfToken" value="" />
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
      </form>
    </Box>
  );
}

export default function NativeStartClient() {
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
      <NativeStartInner />
    </Suspense>
  );
}
