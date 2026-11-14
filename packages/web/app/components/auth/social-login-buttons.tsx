'use client';

import React, { useEffect, useRef, useState } from 'react';
import Skeleton from '@mui/material/Skeleton';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';

import { signInWithSessionIntent as signIn } from '@/app/lib/auth/web-session-events';
import { useTranslation } from 'react-i18next';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';
import { buildNativeOAuthSignInUrl } from '@/app/lib/auth/native-oauth-url';
import { track } from '@/app/lib/analytics';
import { setOAuthPending } from '@/app/lib/oauth-pending-db';

// Note: OAuth provider icons and button colors use brand-specific colors
// per Google/Apple brand guidelines, not design system tokens

const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </svg>
);

const AppleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
  </svg>
);

type ProvidersConfig = {
  google: boolean;
  apple: boolean;
};

type SocialLoginButtonsProps = {
  callbackUrl?: string;
  disabled?: boolean;
};

export default function SocialLoginButtons({ callbackUrl = '/', disabled = false }: SocialLoginButtonsProps) {
  const { t } = useTranslation('auth');
  const [providers, setProviders] = useState<ProvidersConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [isCapacitorApp, setIsCapacitorApp] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  useEffect(() => {
    setIsCapacitorApp(isNativeApp());
  }, []);

  useEffect(() => {
    fetch('/api/auth/providers-config')
      .then((res) => res.json())
      .then((data) => {
        setProviders(data);
        setLoading(false);
      })
      .catch(() => {
        // On error, don't show any OAuth buttons
        setProviders({ google: false, apple: false });
        setLoading(false);
      });
  }, []);

  const handleSocialSignIn = async (provider: 'apple' | 'google') => {
    if (active.current || disabled) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setFailed(false);
    try {
      const flow = isCapacitorApp ? 'native' : 'web';
      track('Login Attempted', {
        auth_method: provider,
        flow,
      });
      // Drop an IDB marker that party-profile-context consumes on the next
      // authenticated-session detection to emit Login Succeeded. NextAuth handles
      // OAuth success via server-side redirect, so there's no explicit client
      // callback to track from — the marker bridges the gap. Stale markers expire
      // after 5 minutes (see oauth-pending-db).
      void setOAuthPending({ provider, flow, attempted_at: Date.now() });

      if (isCapacitorApp) {
        const browser = window.Capacitor?.Plugins?.Browser;
        if (!browser) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');

        const url = buildNativeOAuthSignInUrl({
          origin: window.location.origin,
          provider,
          callbackPath: callbackUrl,
        });

        await browser.open({ url });
        return;
      }

      const response = await signIn(provider, { callbackUrl }, { signal: controller.signal });
      if (response?.error) throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
    } catch {
      if (mounted.current && !controller.signal.aborted) setFailed(true);
    } finally {
      if (active.current === controller) {
        active.current = null;
        if (mounted.current) setPending(false);
      }
    }
  };

  // Don't render anything if no providers are configured
  const hasAnyProvider = providers && (providers.google || providers.apple);

  // Show single skeleton while loading to minimize layout shift
  // (we don't know how many providers are configured yet)
  if (loading) {
    return <Skeleton variant="rectangular" width="100%" height={48} animation="wave" />;
  }

  if (!hasAnyProvider) {
    return null;
  }

  // Apple button needs custom colors per brand guidelines
  const appleButtonStyles = {
    backgroundColor: 'var(--neutral-900)',
    color: 'var(--semantic-surface)',
    borderColor: 'var(--neutral-900)',
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {failed && <Alert severity="error">{t('nativeStart.oauthError')}</Alert>}
      {providers.google && (
        <Button
          fullWidth
          size="large"
          variant="outlined"
          startIcon={<GoogleIcon />}
          onClick={() => handleSocialSignIn('google')}
          disabled={disabled || pending}
        >
          {t('login.providers.google')}
        </Button>
      )}

      {providers.apple && (
        <Button
          fullWidth
          size="large"
          variant="outlined"
          startIcon={<AppleIcon />}
          onClick={() => handleSocialSignIn('apple')}
          disabled={disabled || pending}
          sx={appleButtonStyles}
        >
          {t('login.providers.apple')}
        </Button>
      )}
    </Box>
  );
}
