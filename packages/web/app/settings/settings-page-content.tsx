'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Box from '@mui/material/Box';
import MuiDivider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { useSession } from 'next-auth/react';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { localeHref } from '@/app/lib/i18n/locale-href';
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '@/app/lib/i18n/config';
import { useTranslation } from 'react-i18next';
import Logo from '@/app/components/brand/logo';
import ControllersSection from '@/app/components/account/controllers-section';
import SetPasswordSection from '@/app/components/account/set-password-section';
import BackButton from '@/app/components/back-button';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';

/**
 * Web settings keeps only what the app can't do: register an ESP32 controller
 * (Web Bluetooth/serial hardware that never moved to the SPA) and set a first
 * password for an OAuth-only account (the app has reset-password, not
 * set-password). Profile, board accounts and account deletion all live in the
 * app now — W-21 (#4440).
 *
 * The destination is named explicitly rather than mirroring this pathname: the
 * SPA has no `/settings` route, so the same-path form would hand out a 404. The
 * helper is still the right call for the origin half — it trims a trailing
 * slash off `NEXT_PUBLIC_APP_URL`, which local Expo-web work routinely sets.
 */
const APP_MORE_URL = buildAppHandoffUrl('/profile/more');

type UserProfile = {
  email: string;
  hasPassword: boolean;
  linkedProviders: string[];
};

export default function SettingsPageContent() {
  const { data: session, status } = useSession();
  const router = useLocaleRouter();
  const { t, i18n } = useTranslation('settings');
  const activeLocale: Locale = isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE;
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const { showMessage } = useSnackbar();

  // Redirect unauthenticated users to login with a return URL
  useEffect(() => {
    if (status === 'unauthenticated') {
      const callback = encodeURIComponent(localeHref('/settings', activeLocale));
      router.push(`/auth/login?callbackUrl=${callback}`);
    }
  }, [status, router, activeLocale]);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch('/api/internal/profile');
      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }
      const data = await response.json();
      setProfile(data);
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      showMessage(t('loading.profileError'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showMessage, t]);

  // Fetch profile on mount
  useEffect(() => {
    if (status === 'authenticated') {
      void fetchProfile();
    }
  }, [status, fetchProfile]);

  if (status === 'loading' || loading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          paddingTop: 'var(--global-header-height)',
          background: 'var(--semantic-background)',
        }}
      >
        <Box
          component="main"
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
          }}
        >
          <CircularProgress size={48} />
        </Box>
      </Box>
    );
  }

  if (status === 'unauthenticated') {
    return null;
  }

  return (
    // Page-level translate="no" was removed because it blocked browser
    // translation of every static UI label on this page. The error boundary
    // (app/error.tsx) auto-recovers from any residual translator-DOM
    // NotFoundError (issue #2064).
    <Box
      sx={{
        minHeight: '100vh',
        paddingTop: 'var(--global-header-height)',
        background: 'var(--semantic-background)',
      }}
    >
      <Box
        component="header"
        sx={{
          background: 'var(--semantic-surface)',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          boxShadow: 'var(--shadow-xs)',
          height: 64,
        }}
      >
        <BackButton />
        <Logo size="sm" showText={false} />
        <Typography variant="h4" sx={{ margin: 0, flex: 1 }}>
          {t('title')}
        </Typography>
      </Box>

      <Box
        component="main"
        sx={{
          padding: '24px',
          maxWidth: 600,
          margin: '0 auto',
          width: '100%',
        }}
      >
        <SetPasswordSection
          hasPassword={profile?.hasPassword ?? false}
          userEmail={profile?.email || session?.user?.email || ''}
          linkedProviders={profile?.linkedProviders ?? []}
          onPasswordSet={fetchProfile}
        />

        <MuiDivider sx={{ my: 2 }} />

        <ControllersSection />

        <MuiDivider sx={{ my: 2 }} />

        {/* Everything this page used to carry now lives in the app, so point
            people there by name rather than leaving them to guess. Same-tab
            `component="a"`, matching the two other www→app CTAs
            (`start-climbing-button.tsx`, `playlists/library-page-content.tsx`).
            No open-in-new glyph, because it does not open a new tab. */}
        <Card>
          <CardContent>
            <Typography variant="h5">{t('appHandoff.title')}</Typography>
            <Typography variant="body2" component="span" color="text.secondary" sx={{ display: 'block', mb: 3 }}>
              {t('appHandoff.subtitle')}
            </Typography>
            <Button component="a" variant="contained" href={APP_MORE_URL} fullWidth>
              {t('appHandoff.cta')}
            </Button>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
