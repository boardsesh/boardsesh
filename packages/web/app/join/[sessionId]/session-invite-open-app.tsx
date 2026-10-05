'use client';

import React from 'react';
import Button from '@mui/material/Button';
import OpenInNewOutlined from '@mui/icons-material/OpenInNewOutlined';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { trackBeforeNavigation } from '@/app/lib/analytics';

/**
 * The app's own URL scheme (`scheme` in the mobile app config). The app's
 * deep-link receiver reads `com.boardsesh.app://join/{id}` the same way it
 * reads the https invite link.
 */
const APP_SCHEME = 'com.boardsesh.app';

/** The invite as a link only the app can open. */
export function buildOpenInAppUrl(sessionId: string): string {
  return `${APP_SCHEME}://join/${encodeURIComponent(sessionId)}`;
}

type SessionInviteOpenAppProps = {
  sessionId: string;
  /** Already translated by the server page. */
  label: string;
};

/**
 * "Open in the app", for someone who HAS the app and still landed on this page.
 *
 * That happens when the invite was tapped inside another app's built-in
 * browser (Instagram, WhatsApp and others): those skip the universal link and
 * the App Link, so the phone never offers the app. Telling that visitor to
 * "open this link on your phone" describes what just failed. A link on the
 * app's own scheme is the one thing a page can offer that asks the phone for
 * the app directly.
 *
 * Without the app the link opens nothing (iOS Safari says the address is
 * invalid), which is why it sits under "Already have the app?" and below the
 * store buttons, and is styled as the secondary action.
 */
export default function SessionInviteOpenApp({ sessionId, label }: SessionInviteOpenAppProps) {
  return (
    <Button
      component="a"
      href={buildOpenInAppUrl(sessionId)}
      onClick={() => {
        void trackBeforeNavigation(SHARED_EVENTS.SessionInviteOpenInAppClicked, { sessionId });
      }}
      variant="outlined"
      size="large"
      startIcon={<OpenInNewOutlined />}
      sx={{ textTransform: 'none', mt: 1.5 }}
    >
      {label}
    </Button>
  );
}
