'use client';

import React, { useEffect, useState } from 'react';
import { SessionProvider, signIn } from 'next-auth/react';
import { ReactNode } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';

interface SessionProviderWrapperProps {
  children: ReactNode;
}

export default function SessionProviderWrapper({ children }: SessionProviderWrapperProps) {
  const [deepLinkError, setDeepLinkError] = useState(false);

  useEffect(() => {
    if (!isNativeApp()) {
      return;
    }

    const appPlugin = window.Capacitor?.Plugins?.App;
    if (!appPlugin) {
      return;
    }

    let cancelled = false;
    let listenerHandle: { remove: () => Promise<void> } | null = null;

    appPlugin.addListener('appUrlOpen', async ({ url }) => {
      if (!url.startsWith('com.boardsesh.app://auth/callback')) {
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        await window.Capacitor?.Plugins?.Browser?.close?.();
        window.location.assign('/auth/login');
        return;
      }

      const transferToken = parsed.searchParams.get('transferToken');
      const error = parsed.searchParams.get('error');
      const nextPath = parsed.searchParams.get('next') ?? '/';

      // Close the external browser regardless of outcome
      await window.Capacitor?.Plugins?.Browser?.close?.();

      if (error || !transferToken) {
        // Redirect to login with context about the failure
        window.location.assign('/auth/login');
        return;
      }

      const safeCallbackUrl = nextPath.startsWith('/') ? nextPath : '/';
      const result = await signIn('native-oauth', {
        transferToken,
        callbackUrl: safeCallbackUrl,
        redirect: false,
      });

      if (result?.error) {
        window.location.assign('/auth/login');
        return;
      }

      window.location.assign(result?.url ?? safeCallbackUrl);
    }).then((handle) => {
      if (cancelled) {
        // Component unmounted before the listener was registered — clean up
        void handle.remove();
      } else {
        listenerHandle = handle;
      }
    }).catch((err) => {
      console.error('[Native OAuth] Failed to register appUrlOpen listener:', err);
      setDeepLinkError(true);
    });

    return () => {
      cancelled = true;
      void listenerHandle?.remove();
    };
  }, []);

  return (
    <SessionProvider
      refetchOnWindowFocus={false}
      refetchWhenOffline={false}
    >
      {children}
      <Snackbar
        open={deepLinkError}
        autoHideDuration={8000}
        onClose={() => setDeepLinkError(false)}
      >
        <Alert severity="warning" onClose={() => setDeepLinkError(false)}>
          Sign-in with Google, Apple, or Facebook may not work. Try restarting the app.
        </Alert>
      </Snackbar>
    </SessionProvider>
  );
}
