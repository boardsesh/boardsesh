'use client';

import React from 'react';
import Button from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { useSession } from 'next-auth/react';
import { APP_URL } from '@/app/lib/app-origin';

// Same-origin mint route: a logged-in click 307s through here to
// app.boardsesh.com/auth/callback carrying a transfer token. Same-tab navigation
// (no target=_blank) so the redirect chain completes.
const MINT_HREF = '/api/auth/native/callback?redirect=web&next=/';

type StartClimbingButtonProps = {
  /** Resolved label (callers pass `t(...)` so the i18n linter can follow the key). */
  label: string;
  /** Resolved aria-label. */
  ariaLabel: string;
  size?: 'small' | 'medium' | 'large';
  variant?: 'text' | 'outlined' | 'contained';
  startIcon?: React.ReactNode;
  sx?: SxProps<Theme>;
};

/**
 * "Start climbing" CTA that hands the visitor to the Expo-web app.
 *
 * - Authenticated: link to the same-origin mint route, which 307s to
 *   app.boardsesh.com with a short-lived transfer token (single sign-on).
 * - Unauthenticated: link straight to the app, which shows its own login.
 * - Loading: treated as unauthenticated (plain link to the app) so a token is
 *   never minted before auth resolves.
 */
export default function StartClimbingButton({
  label,
  ariaLabel,
  size = 'medium',
  variant = 'contained',
  startIcon,
  sx,
}: StartClimbingButtonProps) {
  const { status } = useSession();
  const href = status === 'authenticated' ? MINT_HREF : APP_URL;

  return (
    <Button
      component="a"
      href={href}
      aria-label={ariaLabel}
      size={size}
      variant={variant}
      startIcon={startIcon}
      sx={sx}
    >
      {label}
    </Button>
  );
}
