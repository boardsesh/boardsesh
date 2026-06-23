'use client';

// BoardPresencePanel — the entry surface for "now on the wall".
//
// Renders nothing until a board is bound (a BLE serial has been resolved to a
// shared boardId). Once bound, it shows a small entry pill near the bottom bar;
// tapping it opens the BoardSheet and a "Switch board" footer dispatches the
// existing board switcher. No board bound ⇒ this returns null and the app's
// board-header behaviour is exactly as today.
//
// Mounted as a child of WebBoardPresenceProvider (so it can read the wall
// context) and of the queue bridge (so it can label the active board).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useBoardPresenceCurrent, useBoardPresenceFeed } from '@boardsesh/board-presence-react';
import { themeTokens } from '@/app/theme/theme-config';
import { track } from '@/app/lib/analytics';
import { useQueueBridgeBoardInfo } from '../queue-control/queue-bridge-context';
import { useBoardPresenceControls } from './board-presence-context';
import { BoardSheet } from './board-sheet';
import { BOARD_PRESENCE_SWITCH_BOARD_EVENT } from './board-presence-events';

export function BoardPresencePanel() {
  const { t } = useTranslation('session');
  const { boardId } = useBoardPresenceControls();
  const { boardDetails, angle } = useQueueBridgeBoardInfo();
  const { currentClimb } = useBoardPresenceCurrent();
  const { history } = useBoardPresenceFeed();
  const [open, setOpen] = useState(false);
  const historyViewedForOpenRef = useRef(false);

  const boardLabel = boardDetails
    ? [boardDetails.layout_name, Number.isFinite(angle) ? `${angle}°` : null].filter(Boolean).join(' • ') || null
    : null;

  const handleOpen = useCallback(() => {
    track(SHARED_EVENTS.BoardSheetOpened, {
      boardId: boardId ?? undefined,
      source: 'board_pill',
    });
    setOpen(true);
  }, [boardId]);

  const handleClose = useCallback(() => setOpen(false), []);

  const handleSwitchBoard = useCallback(() => {
    track(SHARED_EVENTS.BoardSwapInvokedFromSheet, { boardId: boardId ?? undefined });
    setOpen(false);
    window.dispatchEvent(new CustomEvent(BOARD_PRESENCE_SWITCH_BOARD_EVENT));
  }, [boardId]);

  useEffect(() => {
    if (!open) {
      historyViewedForOpenRef.current = false;
      return;
    }
    if (historyViewedForOpenRef.current || history.length === 0) return;
    historyViewedForOpenRef.current = true;
    track(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: boardId ?? undefined,
      itemCount: history.length,
    });
  }, [open, history.length, boardId]);

  // No board bound: render nothing. The shared wall context is inert in this
  // state, so there's nothing meaningful to show anyway.
  if (boardId === null) return null;

  return (
    <>
      <ButtonBase
        onClick={handleOpen}
        aria-label={
          currentClimb?.name
            ? t('boardPresence.openAriaWithClimb', { name: currentClimb.name })
            : t('boardPresence.openAria')
        }
        sx={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: `calc(${themeTokens.layout.bottomNavSpacer} + ${themeTokens.spacing[2]}px)`,
          zIndex: themeTokens.zIndex.fixed,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.5,
          py: 0.75,
          minHeight: 44,
          borderRadius: `${themeTokens.borderRadius.full}px`,
          bgcolor: 'background.paper',
          boxShadow: 3,
          color: 'text.primary',
        }}
      >
        <LightbulbOutlined sx={{ fontSize: 18, color: 'var(--color-warning)' }} />
        <Box sx={{ textAlign: 'left', maxWidth: 180 }}>
          <Typography variant="caption" sx={{ display: 'block', fontWeight: 700, lineHeight: 1.1 }} noWrap>
            {t('boardPresence.open')}
          </Typography>
          {currentClimb?.name ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.1 }} noWrap>
              {currentClimb.name}
            </Typography>
          ) : null}
        </Box>
      </ButtonBase>
      <Box component="span" aria-live="polite" aria-atomic="true" sx={visuallyHiddenSx}>
        {currentClimb?.name ? t('boardPresence.nowOnWallAnnouncement', { name: currentClimb.name }) : ''}
      </Box>
      <BoardSheet open={open} boardLabel={boardLabel} onClose={handleClose} onSwitchBoard={handleSwitchBoard} />
    </>
  );
}

const visuallyHiddenSx = {
  border: 0,
  clip: 'rect(0 0 0 0)',
  height: 1,
  margin: -1,
  overflow: 'hidden',
  padding: 0,
  position: 'absolute',
  whiteSpace: 'nowrap',
  width: 1,
} as const;
