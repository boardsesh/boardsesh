'use client';

import React, { useCallback } from 'react';
import MuiButton from '@mui/material/Button';
import type { SxProps, Theme } from '@mui/material/styles';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import { trackLinkClick } from '@/app/lib/website-journey-analytics';

type PlaylistHandoffButtonProps = {
  playlistUuid: string;
  boardType: string;
  layoutId: number | null | undefined;
  isPublic: boolean;
  locale: string;
  /** What the link shows: `HandoffLabels`, the words for a phone and for a laptop. */
  children: React.ReactNode;
  /** The link's look, which is the caller's: a text link on a phone, the filled button on a laptop. */
  sx?: SxProps<Theme>;
  /** Names the link for the page's tests (`data-cta`). */
  ctaName?: string;
};

/**
 * The hand-off: opens this playlist on app.boardsesh.com.
 *
 * Lighting the wall lives in the app. A plain cross-origin anchor, never a
 * redirect: www and app share the `.boardsesh.com` session cookie, so there is
 * no token to hand over (same contract as start-climbing-button.tsx). The click
 * handler only adds `Playlist Handoff Clicked`, the sibling of the climb page's
 * `Climb Handoff Clicked`, and holds a same-tab navigation for the same bounded
 * flush so the event is not lost with the page.
 *
 * How it looks is the caller's, as with `ClimbHandoffLink`: `PlaylistHeroCta`
 * makes it a text link on a phone and the filled button on a laptop. It stays
 * `variant="text"`, so a phone's store button is the only contained one.
 */
export default function PlaylistHandoffButton({
  playlistUuid,
  boardType,
  layoutId,
  isPublic,
  locale,
  children,
  sx,
  ctaName,
}: PlaylistHandoffButtonProps) {
  const handleClick = useCallback(
    (click: React.MouseEvent<HTMLAnchorElement>) => {
      trackLinkClick(click, SHARED_EVENTS.PlaylistHandoffClicked, {
        // Per-event, like the climb hand-off: one `environment` filter spans
        // both hand-offs without retagging every other www event.
        environment: 'production-web',
        surface: 'playlist_front_door',
        boardName: boardType,
        layoutId: layoutId ?? null,
        isPublic,
        // A private playlist's id stays out of analytics.
        playlistUuid: isPublic ? playlistUuid : undefined,
        locale,
        campaign: 'front_door',
      });
    },
    [boardType, layoutId, isPublic, playlistUuid, locale],
  );

  return (
    <MuiButton
      variant="text"
      size="large"
      component="a"
      href={buildAppHandoffUrl(`/discover/${playlistUuid}`)}
      onClick={handleClick}
      sx={sx}
      data-cta={ctaName}
    >
      {children}
    </MuiButton>
  );
}
