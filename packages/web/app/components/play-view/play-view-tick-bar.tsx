'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import KeyboardArrowUpOutlined from '@mui/icons-material/KeyboardArrowUpOutlined';
import KeyboardArrowDownOutlined from '@mui/icons-material/KeyboardArrowDownOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import { TickIcon, TickButtonWithLabel } from '../logbook/tick-icon';
import { PersonFallingIcon } from '@/app/components/icons/person-falling-icon';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { themeTokens } from '@/app/theme/theme-config';
import { QuickTickBar, type QuickTickBarHandle } from '../logbook/quick-tick-bar';
import { hasPriorHistoryForClimb } from '@/app/hooks/use-tick-save';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { useIsDarkMode } from '@/app/hooks/use-is-dark-mode';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import type { BoardDetails, Angle, Climb } from '@/app/lib/types';
import styles from './play-view-drawer.module.css';

/**
 * Extracted tick bar component that owns its own `tickComment` state.
 * This prevents comment keystrokes from invalidating the parent `aboveFold` useMemo,
 * which would otherwise re-render the entire board carousel on every keystroke.
 */
export type PlayViewTickBarProps = {
  isTickBarActive: boolean;
  currentClimb: Climb;
  angle: Angle;
  boardDetails: BoardDetails;
  onClose: () => void;
  onError: () => void;
};

export const PlayViewTickBar = React.memo<PlayViewTickBarProps>(function PlayViewTickBar({
  isTickBarActive,
  currentClimb,
  angle,
  boardDetails,
  onClose,
  onError,
}) {
  const { t } = useTranslation('session');
  const { logbook } = useBoardProvider();
  const [tickComment, setTickComment] = useState('');
  const [commentFocused, setCommentFocused] = useState(false);
  const [isFlash, setIsFlash] = useState(() => !hasPriorHistoryForClimb(currentClimb, logbook));
  const [tickBarExpanded, setTickBarExpanded] = useState(false);
  const quickTickBarRef = useRef<QuickTickBarHandle>(null);
  const isDark = useIsDarkMode();
  // Opaque surface base + grade tint overlay (matches queue control bar pattern).
  const gradeTintColor = useMemo(
    () => getGradeTintColor(currentClimb.difficulty, 'default', isDark),
    [currentClimb.difficulty, isDark],
  );

  // Restore persisted tick bar expanded state when tick bar opens
  useEffect(() => {
    if (isTickBarActive) {
      void getPreference<boolean>('tickBarExpanded').then((persisted) => {
        if (persisted === true) setTickBarExpanded(true);
      });
    }
  }, [isTickBarActive]);

  // Persist expanded state on user-initiated toggle (not on automatic resets)
  const handleTickBarExpandedChange = useCallback((expanded: boolean) => {
    setTickBarExpanded(expanded);
    void setPreference('tickBarExpanded', expanded);
  }, []);

  const handleCommentFocus = useCallback(() => setCommentFocused(true), []);
  const handleCommentBlur = useCallback(() => setCommentFocused(false), []);

  // Reset comment when the tick bar closes
  const handleClose = useCallback(() => {
    setTickComment('');
    setCommentFocused(false);
    setIsFlash(false);
    setTickBarExpanded(false);
    onClose();
  }, [onClose]);

  // Reset comment and recompute flash state when the climb changes.
  useEffect(() => {
    setTickComment('');
    setCommentFocused(false);
    setIsFlash(!hasPriorHistoryForClimb(currentClimb, logbook));
    setTickBarExpanded(false);
  }, [currentClimb, logbook]);

  return (
    <div className={`${styles.tickBarContainer} ${isTickBarActive ? styles.tickBarContainerActive : ''}`}>
      <div
        className={styles.tickBarInner}
        style={{
          backgroundColor: isDark ? 'var(--semantic-surfaceElevated)' : 'var(--semantic-surface)',
          // Grade tint as a solid overlay via linear-gradient (single-color gradient)
          ...(gradeTintColor ? { backgroundImage: `linear-gradient(${gradeTintColor}, ${gradeTintColor})` } : {}),
        }}
      >
        {isTickBarActive && (
          <>
            {/* Toolbar: expand left, close right — same pattern as queue-control-bar */}
            <div className={styles.tickBarToolbar}>
              <div
                className={styles.tickBarExpandButton}
                onClick={() => handleTickBarExpandedChange(!tickBarExpanded)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleTickBarExpandedChange(!tickBarExpanded);
                }}
                aria-label={tickBarExpanded ? t('playView.tickBar.collapseAria') : t('playView.tickBar.expandAria')}
              >
                {tickBarExpanded ? (
                  <KeyboardArrowDownOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                ) : (
                  <KeyboardArrowUpOutlined sx={{ fontSize: 16, opacity: 0.7 }} />
                )}
                <span className={styles.tickBarExpandLabel}>
                  {tickBarExpanded ? t('queueBar.tickBar.collapse') : t('queueBar.tickBar.expand')}
                </span>
              </div>
              <div className={styles.tickBarCloseButton}>
                <IconButton
                  size="small"
                  onClick={handleClose}
                  aria-label={t('playView.tickBar.closeAria')}
                  sx={{
                    color: 'text.primary',
                    backgroundColor: 'action.selected',
                    '&:hover': { backgroundColor: 'action.focus' },
                    padding: '2px',
                  }}
                >
                  <CloseOutlined sx={{ fontSize: 16 }} />
                </IconButton>
              </div>
            </div>
            <QuickTickBar
              ref={quickTickBarRef}
              currentClimb={currentClimb}
              angle={angle}
              boardDetails={boardDetails}
              onSave={handleClose}
              onError={onError}
              onDraftRestored={(draftComment) => setTickComment(draftComment)}
              onIsFlashChange={setIsFlash}
              comment={tickComment}
              expanded={tickBarExpanded}
              commentSlot={
                <div className={`${styles.tickBarComment} ${commentFocused ? styles.tickBarCommentExpanded : ''}`}>
                  <TextField
                    fullWidth
                    size="small"
                    variant="outlined"
                    placeholder={t('common:comment.shortPlaceholder')}
                    multiline
                    minRows={1}
                    maxRows={commentFocused ? 4 : 1}
                    value={tickComment}
                    onChange={(e) => setTickComment(e.target.value)}
                    onFocus={handleCommentFocus}
                    onBlur={handleCommentBlur}
                    slotProps={{
                      htmlInput: { maxLength: 2000, 'aria-label': t('playView.tickBar.commentAria') },
                      input: {
                        startAdornment: (
                          <InputAdornment position="start">
                            <ChatBubbleOutlineOutlined sx={{ fontSize: 16, opacity: 0.5 }} />
                          </InputAdornment>
                        ),
                      },
                    }}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        borderRadius: '8px',
                        backgroundColor: 'var(--input-bg)',
                        '& .MuiOutlinedInput-notchedOutline': {
                          borderColor: 'var(--neutral-200)',
                        },
                      },
                    }}
                  />
                </div>
              }
              expandedCommentSlot={
                <TextField
                  fullWidth
                  size="small"
                  variant="outlined"
                  placeholder={t('playView.tickBar.commentPlaceholder')}
                  multiline
                  minRows={2}
                  maxRows={4}
                  value={tickComment}
                  onChange={(e) => setTickComment(e.target.value)}
                  onFocus={handleCommentFocus}
                  onBlur={handleCommentBlur}
                  slotProps={{
                    htmlInput: { maxLength: 2000, 'aria-label': t('playView.tickBar.commentAria') },
                  }}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      borderRadius: '8px',
                      backgroundColor: 'var(--input-bg)',
                      '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'var(--neutral-200)',
                      },
                    },
                  }}
                />
              }
            />
            {/* Action buttons — attempt + tick (order matches queue control bar) */}

            <div className={styles.tickBarButtons}>
              <TickButtonWithLabel label={t('playView.tickBar.attemptLabel')}>
                <IconButton
                  onClick={(e) => quickTickBarRef.current?.saveAttempt(e.currentTarget)}
                  sx={{
                    backgroundColor: themeTokens.colors.errorMuted,
                    color: 'var(--color-error)',
                    '&:hover': { backgroundColor: themeTokens.colors.errorMutedHover },
                  }}
                  aria-label={t('playView.tickBar.logAttemptAria')}
                >
                  <PersonFallingIcon />
                </IconButton>
              </TickButtonWithLabel>
              <TickButtonWithLabel label={isFlash ? t('playView.tickBar.flashLabel') : t('playView.tickBar.tickLabel')}>
                <IconButton
                  id="button-tick"
                  onClick={(e) => quickTickBarRef.current?.save(e.currentTarget)}
                  sx={{
                    backgroundColor: isFlash ? themeTokens.colors.amber : 'var(--color-success)',
                    color: isFlash ? themeTokens.neutral[900] : 'common.white',
                    transition: 'background-color 150ms ease, color 150ms ease',
                    '&:hover': {
                      backgroundColor: isFlash ? themeTokens.colors.amber : 'var(--color-success-hover)',
                    },
                  }}
                  aria-label={t('playView.tickBar.saveTickAria')}
                >
                  <TickIcon isFlash={!!isFlash} />
                </IconButton>
              </TickButtonWithLabel>
            </div>
          </>
        )}
      </div>
    </div>
  );
});
PlayViewTickBar.displayName = 'PlayViewTickBar';
