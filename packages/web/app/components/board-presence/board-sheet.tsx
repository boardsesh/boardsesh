'use client';

// Board sheet — "now on the wall" (the board-presence primary surface on web).
//
// A bottom MUI Drawer sibling of the queue/play drawers. Renders the wall's
// now-on-the-wall hero, light stat tiles, a history list, and a SEPARATE
// "Switch board" footer row that opens the existing board switcher (via a
// window event the bottom tab bar listens for).
//
// PERF: `BoardSheet` itself (the header/footer chrome + the boardId lookup)
// never reads the volatile current/feed contexts — those live in
// `BoardSheetBody`, rendered as an actual JSX CHILD of `<Drawer>`. A MUI
// temporary Drawer without `keepMounted` unmounts its children once fully
// closed, so `BoardSheetBody` (and thus its presence subscriptions) mounts and
// unmounts with the sheet — a closed sheet subscribes to nothing. Calling
// `useBoardPresenceCurrent`/`useBoardPresenceFeed` directly in `BoardSheet`
// would defeat this: that top-level hook call runs on every render of
// `BoardSheet` regardless of Drawer's own mount state, since `BoardSheet` is
// rendered unconditionally by the always-mounted entry pill.

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Drawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ButtonBase from '@mui/material/ButtonBase';
import Button from '@mui/material/Button';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import ChevronRightOutlined from '@mui/icons-material/ChevronRightOutlined';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import {
  boardHistoryEntryKey,
  useBoardHistoryPagination,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
} from '@boardsesh/board-presence-react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { themeTokens } from '@/app/theme/theme-config';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { track } from '@/app/lib/analytics';
import { DEFAULT_GRADE_COLOR, getGradeTextColor } from '@/app/lib/grade-colors';
import { useBoardPresenceControls } from './board-presence-context';

type BoardSheetProps = {
  open: boolean;
  /** The active board label, shown as the sheet subtitle + footer subtitle. */
  boardLabel: string | null;
  onClose: () => void;
  /** Open the existing board switcher (the separated "Switch board" control). */
  onSwitchBoard: () => void;
};

export function BoardSheet({ open, boardLabel, onClose, onSwitchBoard }: BoardSheetProps) {
  const { t } = useTranslation('session');
  // `boardId` comes from the stable controls context (changes only when the
  // bound board itself changes, not on every wall event), so reading it here
  // in the always-mounted wrapper is cheap — unlike current/feed below.
  const { boardId } = useBoardPresenceControls();

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: themeTokens.borderRadius.xl,
            borderTopRightRadius: themeTokens.borderRadius.xl,
            maxHeight: '85dvh',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          pt: 2,
          pb: 1.5,
        }}
      >
        <Box>
          <Typography variant="h6" component="h2" sx={{ lineHeight: 1.2 }}>
            {t('boardPresence.title')}
          </Typography>
          {boardLabel ? (
            <Typography variant="caption" color="text.secondary" noWrap>
              {boardLabel}
            </Typography>
          ) : null}
        </Box>
        <IconButton onClick={onClose} aria-label={t('boardPresence.close')} edge="end" size="large">
          <CloseOutlined />
        </IconButton>
      </Box>
      <Divider />

      <BoardSheetBody boardId={boardId} />

      <Divider />
      <ButtonBase
        onClick={onSwitchBoard}
        aria-label={t('boardPresence.switchBoardAria')}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          px: 2,
          py: 1.75,
          pb: `calc(${themeTokens.spacing[4]}px + ${themeTokens.layout.safeAreaBottom})`,
          textAlign: 'left',
        }}
      >
        <Box>
          <Typography variant="body1">{t('boardPresence.switchBoard')}</Typography>
          {boardLabel ? (
            <Typography variant="caption" color="text.secondary" noWrap>
              {boardLabel}
            </Typography>
          ) : null}
        </Box>
        <ChevronRightOutlined sx={{ color: 'text.disabled' }} />
      </ButtonBase>
    </Drawer>
  );
}

/**
 * Everything that reads the wall's live state: the hero, stat tiles, and the
 * history list. Rendered as a real JSX child of `<Drawer>` (not conditionally
 * gated by a prop check) so it mounts/unmounts with the Drawer itself — a
 * closed sheet subscribes to none of the presence contexts.
 */
function BoardSheetBody({ boardId }: { boardId: number | null }) {
  const { t } = useTranslation('session');
  const { formatGrade, getGradeColor } = useGradeFormat();
  const { currentClimb } = useBoardPresenceCurrent();
  const { history, stats } = useBoardPresenceFeed();

  // "Load older" — pages further back through the durable history log, past
  // the live feed's in-memory HISTORY_CAP window.
  const handleHistoryPageLoaded = useCallback(
    (info: { pageSize: number; returnedCount: number }) => {
      track(SHARED_EVENTS.BoardHistoryPageLoaded, {
        boardId: boardId ?? undefined,
        pageSize: info.pageSize,
        returnedCount: info.returnedCount,
      });
    },
    [boardId],
  );
  const { olderHistory, isLoadingOlder, hasMore, loadOlder } = useBoardHistoryPagination(
    undefined,
    handleHistoryPageLoaded,
  );
  // The hook dedupes each page only at resolve time; the live window can gain
  // lower seqs AFTERWARDS (backfill / foreground catch-up merge — seam 2 in
  // the hook's header), so re-filter here or overlapping entries would render
  // twice with duplicate React keys.
  const combinedHistory = useMemo(() => {
    if (olderHistory.length === 0) return history;
    const liveKeys = new Set(history.map(boardHistoryEntryKey));
    const dedupedOlder = olderHistory.filter((climb) => !liveKeys.has(boardHistoryEntryKey(climb)));
    return dedupedOlder.length === 0 ? history : [...history, ...dedupedOlder];
  }, [history, olderHistory]);

  // Fires once per open, when history is first non-empty. This body mounts
  // fresh each time the Drawer opens (unmounted while closed), so the ref
  // naturally resets per open — mirrors the mobile `BoardSheetContent`.
  const historyViewedForOpenRef = useRef(false);
  useEffect(() => {
    if (historyViewedForOpenRef.current || history.length === 0) return;
    historyViewedForOpenRef.current = true;
    track(SHARED_EVENTS.BoardHistoryViewed, {
      boardId: boardId ?? undefined,
      itemCount: history.length,
    });
  }, [history.length, boardId]);

  const statTiles = useMemo(() => {
    if (!stats) return [];
    return [
      { key: 'sent', value: String(stats.climbsSentCount), label: t('boardPresence.statSent') },
      { key: 'climbers', value: String(stats.distinctClimbersCount), label: t('boardPresence.statClimbers') },
      {
        key: 'hardest',
        value: stats.hardestGrade ? (formatGrade(stats.hardestGrade) ?? '–') : '–',
        label: t('boardPresence.statHardest'),
      },
      {
        key: 'top',
        value: stats.topGrade ? (formatGrade(stats.topGrade) ?? '–') : '–',
        label: t('boardPresence.statTopGrade'),
      },
    ];
  }, [stats, formatGrade, t]);

  // Stabilized so `NowOnTheWallHero`/`HistoryRow` (both `React.memo`'d) can
  // actually bail on an unrelated re-render (e.g. a stats-only push) instead
  // of recreating these as fresh inline arrows every render.
  const setByLine = useCallback((setter: string) => t('boardPresence.setByLine', { setter }), [t]);
  const litByLine = useCallback((name: string) => t('boardPresence.litByLine', { name }), [t]);

  return (
    <Box sx={{ overflowY: 'auto', flex: 1 }}>
      {currentClimb ? (
        <NowOnTheWallHero
          climb={currentClimb}
          formattedGrade={currentClimb.grade ? formatGrade(currentClimb.grade) : null}
          gradeColor={getGradeColor(currentClimb.grade) ?? DEFAULT_GRADE_COLOR}
          setByLine={setByLine}
          litByLine={litByLine}
        />
      ) : (
        <Box sx={{ textAlign: 'center', px: 4, py: 6 }}>
          <LightbulbOutlined sx={{ fontSize: 40, color: 'text.disabled', mb: 1 }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {t('boardPresence.emptyTitle')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t('boardPresence.emptyBody')}
          </Typography>
        </Box>
      )}

      {statTiles.length > 0 ? (
        <Box sx={{ px: 2, pb: 1 }}>
          <SectionHeader>{t('boardPresence.statsHeader')}</SectionHeader>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {statTiles.map((tile) => (
              <Box
                key={tile.key}
                sx={{
                  flexGrow: 1,
                  flexBasis: '47%',
                  bgcolor: 'action.hover',
                  borderRadius: `${themeTokens.borderRadius.md}px`,
                  px: 1.5,
                  py: 1.25,
                }}
              >
                <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }} noWrap>
                  {tile.value}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {tile.label}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}

      {combinedHistory.length > 0 ? (
        <Box sx={{ px: 2, pb: 1 }}>
          <SectionHeader>{t('boardPresence.historyHeader')}</SectionHeader>
          <List disablePadding>
            {combinedHistory.map((climb) => (
              <HistoryRow
                key={boardHistoryEntryKey(climb)}
                climb={climb}
                formattedGrade={climb.grade ? formatGrade(climb.grade) : null}
                gradeColor={getGradeColor(climb.grade) ?? DEFAULT_GRADE_COLOR}
                litByLine={litByLine}
              />
            ))}
          </List>
        </Box>
      ) : null}

      {/* Gated on `hasMore` alone — NOT the list being non-empty. A wall
          that's been quiet longer than the Redis window's TTL has an EMPTY
          live window but durable boardHistory rows; this button (the hook
          supports a cursor-less first page) is then the only way to reach
          them. It sits under the list when there is one, under the empty
          state when there isn't. */}
      {hasMore ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', px: 2, pb: 1 }}>
          <Button onClick={loadOlder} disabled={isLoadingOlder} size="small">
            {isLoadingOlder ? t('boardPresence.loadingMore') : t('boardPresence.loadMore')}
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="overline" color="text.secondary" sx={{ display: 'block', pt: 1.5, pb: 1, letterSpacing: 0.5 }}>
      {children}
    </Typography>
  );
}

type HeroProps = {
  climb: BoardPresenceClimb;
  formattedGrade: string | null;
  gradeColor: string;
  setByLine: (setter: string) => string;
  litByLine: (name: string) => string;
};

// React.memo — the reducer preserves per-entry object identity across a
// backfill/catch-up that doesn't actually change this climb (see
// `mergeHistory` in `@boardsesh/board-presence`), so with `setByLine`/
// `litByLine` stabilized above, this bails on an unrelated stats-only update.
const NowOnTheWallHero = React.memo(function NowOnTheWallHeroInner({
  climb,
  formattedGrade,
  gradeColor,
  setByLine,
  litByLine,
}: HeroProps) {
  const setter = climb.setter?.trim();
  const litBy = climb.sentByDisplayName?.trim();
  return (
    <Box
      sx={{
        m: 2,
        p: 2,
        bgcolor: 'action.hover',
        borderRadius: `${themeTokens.borderRadius.lg}px`,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }} noWrap>
          {climb.name ?? ''}
        </Typography>
        {formattedGrade ? (
          <Chip
            label={formattedGrade}
            size="small"
            sx={{
              bgcolor: gradeColor,
              color: getGradeTextColor(gradeColor),
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          />
        ) : null}
      </Box>
      {setter ? (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {setByLine(setter)}
        </Typography>
      ) : null}
      {litBy ? (
        <Typography variant="caption" sx={{ display: 'block', color: 'var(--color-live)' }} noWrap>
          {litByLine(litBy)}
        </Typography>
      ) : null}
    </Box>
  );
});

type HistoryRowProps = {
  climb: BoardPresenceClimb;
  formattedGrade: string | null;
  gradeColor: string;
  litByLine: (name: string) => string;
};

// React.memo for the same reason as `NowOnTheWallHero` — pairs with the
// reducer's identity-preserving backfill merge so an unrelated stats/current
// update doesn't re-render every row in the list.
const HistoryRow = React.memo(function HistoryRowInner({
  climb,
  formattedGrade,
  gradeColor,
  litByLine,
}: HistoryRowProps) {
  const litBy = climb.sentByDisplayName?.trim();
  return (
    <ListItem
      disableGutters
      secondaryAction={
        formattedGrade ? (
          <Chip
            label={formattedGrade}
            size="small"
            sx={{
              bgcolor: gradeColor,
              color: getGradeTextColor(gradeColor),
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          />
        ) : undefined
      }
    >
      <ListItemText
        primary={climb.name ?? ''}
        secondary={litBy ? litByLine(litBy) : undefined}
        slotProps={{ primary: { noWrap: true, fontWeight: 600 }, secondary: { noWrap: true } }}
      />
    </ListItem>
  );
});
