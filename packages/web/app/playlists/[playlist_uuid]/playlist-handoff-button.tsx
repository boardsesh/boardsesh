'use client';

import React, { useCallback } from 'react';
import MuiButton from '@mui/material/Button';
import ElectricBoltOutlined from '@mui/icons-material/ElectricBoltOutlined';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { buildAppHandoffUrl } from '@/app/lib/app-handoff';
import { trackLinkClick } from '@/app/lib/website-journey-analytics';

type PlaylistHandoffButtonProps = {
  playlistUuid: string;
  boardType: string;
  layoutId: number | null | undefined;
  isPublic: boolean;
  locale: string;
  label: string;
};

/**
 * "Climb this in the app": opens this playlist on app.boardsesh.com.
 *
 * Lighting the wall lives in the app. A plain cross-origin anchor, never a
 * redirect: www and app share the `.boardsesh.com` session cookie, so there is
 * no token to hand over (same contract as start-climbing-button.tsx). The click
 * handler only adds `Playlist Handoff Clicked`, the sibling of the climb page's
 * `Climb Handoff Clicked`, and holds a same-tab navigation for the same bounded
 * flush so the event is not lost with the page.
 */
export default function PlaylistHandoffButton({
  playlistUuid,
  boardType,
  layoutId,
  isPublic,
  locale,
  label,
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
      variant="contained"
      size="large"
      component="a"
      href={buildAppHandoffUrl(`/discover/${playlistUuid}`)}
      startIcon={<ElectricBoltOutlined />}
      onClick={handleClick}
    >
      {label}
    </MuiButton>
  );
}
