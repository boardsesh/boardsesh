'use client';

import React, { useCallback } from 'react';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '@/app/lib/analytics';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import { themeTokens } from '@/app/theme/theme-config';

export type HandoffSurface = 'climb_front_door' | 'list_front_door';
/** Which www route tree the reader came from — the config-tuple tree or `/b/{slug}`. */
export type HandoffTree = 'config-tuple' | 'slug';

type ClimbHandoffCtaProps = {
  /**
   * The www pathname to hand off, locale prefix included or not — the
   * builder strips it. NOT a full URL and never carries a query string: the
   * CTA contract is "the same pathname on the app origin".
   */
  pathname: string;
  label: string;
  ariaLabel: string;
  helperText?: string;
  surface: HandoffSurface;
  tree: HandoffTree;
  boardName: string;
  layoutId: number;
  angle: number;
  climbUuid?: string;
  locale: string;
};

const wrapperSx = {
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'flex-start',
  gap: `${themeTokens.spacing[2]}px`,
  margin: `${themeTokens.spacing[6]}px 0`,
};

const helperSx = { color: 'var(--neutral-400)' };

/**
 * The one action on the front door: open this exact route in the app.
 *
 * It is a real `<a href>` rendered on the server, so it is crawlable and it
 * works with JavaScript off; the click handler only adds telemetry. The href
 * carries no UTM parameters — `buildAppHandoffUrl`'s contract is the same
 * pathname on the app origin, and a query string would break the app's route
 * match — so campaign attribution rides as event properties instead.
 */
export default function ClimbHandoffCta({
  pathname,
  label,
  ariaLabel,
  helperText,
  surface,
  tree,
  boardName,
  layoutId,
  angle,
  climbUuid,
  locale,
}: ClimbHandoffCtaProps) {
  const href = buildAppHandoffUrl(pathname);

  const handleClick = useCallback(() => {
    track(SHARED_EVENTS.ClimbHandoffClicked, {
      // A per-event property, deliberately, not a session super property.
      // PostHog resolves per-event properties over super properties, so this
      // survives www later registering an `environment` super property while
      // leaving $pageview / $web_vitals and the ~120 other www events — none of
      // which has ever carried the tag — reading exactly as they do today.
      environment: 'production-web',
      surface,
      tree,
      boardName,
      layoutId,
      angle,
      climbUuid,
      locale,
      campaign: 'front_door',
    });
  }, [surface, tree, boardName, layoutId, angle, climbUuid, locale]);

  return (
    <Box sx={wrapperSx}>
      <Button component="a" href={href} variant="contained" size="large" aria-label={ariaLabel} onClick={handleClick}>
        {label}
      </Button>
      {helperText ? (
        <Typography variant="body2" sx={helperSx}>
          {helperText}
        </Typography>
      ) : null}
    </Box>
  );
}
