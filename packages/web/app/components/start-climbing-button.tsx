'use client';

import React from 'react';
import Button from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { APP_URL } from '@/app/lib/app-origin';

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
 * "Start climbing" CTA: a plain same-tab link to the Expo-web app at
 * `app.boardsesh.com`.
 *
 * There's no session hand-off to do — www and app share a `.boardsesh.com`
 * HttpOnly NextAuth cookie, so a logged-in visitor arrives at the app already
 * authenticated and a logged-out visitor gets the app's own login. Same for
 * every visitor, so this stays a static link with no auth state to read.
 */
export default function StartClimbingButton({
  label,
  ariaLabel,
  size = 'medium',
  variant = 'contained',
  startIcon,
  sx,
}: StartClimbingButtonProps) {
  return (
    <Button
      component="a"
      href={APP_URL}
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
