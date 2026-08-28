'use client';

// ViewerKioskPresenceHub — the kiosk presence spine for a SIGNED-IN viewer.
//
// Same tree as the default `KioskPresenceHub`, but it carries the viewer's ws
// auth token. The gym-manage kiosk preview is the only consumer: it renders
// the gym's boards from `gymKiosk`'s `viewerCanEditGym` branch, which includes
// PRIVATE boards that an anonymous presence read masks as NOT_FOUND. It also
// keeps a gym editor in their per-user rate-limit bucket rather than the
// shared `ip:` one.
//
// It lives in its own module so the display routes' bundle never pulls in the
// ws-auth bridge (and, through it, `next-auth/react`) at all.

import React from 'react';
import { createWebBoardPresenceClient } from '@/app/lib/realtime/board-presence-client';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { KioskPresenceHubInner, type KioskPresenceHubProps } from './kiosk-presence-hub';

export function ViewerKioskPresenceHub({ boardIds, children }: KioskPresenceHubProps) {
  const { token, isLoading } = useWsAuthToken();

  return (
    <KioskPresenceHubInner
      boardIds={boardIds}
      authToken={token}
      isAuthResolving={isLoading}
      createPresenceClient={createWebBoardPresenceClient}
    >
      {children}
    </KioskPresenceHubInner>
  );
}
