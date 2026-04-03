'use client';

import React, { useEffect } from 'react';
import { SessionProvider, signIn } from 'next-auth/react';
import { ReactNode } from 'react';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';

interface SessionProviderWrapperProps {
  children: ReactNode;
}

export default function SessionProviderWrapper({ children }: SessionProviderWrapperProps) {
  useEffect(() => {
    if (!isNativeApp()) {
      return;
    }

    const appPlugin = window.Capacitor?.Plugins?.App;
    if (!appPlugin) {
      return;
    }

    let listenerHandle: { remove: () => Promise<void> } | null = null;

    appPlugin.addListener('appUrlOpen', async ({ url }) => {
      if (!url.startsWith('com.boardsesh.app://auth/callback')) {
        return;
      }

      const parsed = new URL(url);
      const transferToken = parsed.searchParams.get('transferToken');
      const nextPath = parsed.searchParams.get('next') ?? '/';

      await window.Capacitor?.Plugins?.Browser?.close?.();

      if (!transferToken) {
        return;
      }

      const safeCallbackUrl = nextPath.startsWith('/') ? nextPath : '/';
      const result = await signIn('native-oauth', {
        transferToken,
        callbackUrl: safeCallbackUrl,
        redirect: false,
      });

      if (result?.url) {
        window.location.assign(result.url);
      } else {
        window.location.assign(safeCallbackUrl);
      }
    }).then((handle) => {
      listenerHandle = handle;
    }).catch((error) => {
      console.error('[Native OAuth] Failed to register appUrlOpen listener:', error);
    });

    return () => {
      void listenerHandle?.remove();
    };
  }, []);

  return (
    <SessionProvider
      refetchOnWindowFocus={false}
      refetchWhenOffline={false}
    >
      {children}
    </SessionProvider>
  );
}
