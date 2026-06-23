'use client';

// Board sheet — "now on the wall" (the board-presence primary surface on web).
//
// A bottom MUI Drawer sibling of the queue/play drawers. Renders the wall's
// now-on-the-wall hero, light stat tiles, a history list, and a SEPARATE
// "Switch board" footer row that opens the existing board switcher (via a
// window event the bottom tab bar listens for).
//
// State comes from `@boardsesh/board-presence-react`'s split current/feed
// contexts, which are inert until a board is bound — so this sheet is only ever
// opened from the entry pill once a BLE serial has resolved to a board.

import React, { useMemo } from 'react';
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
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import ChevronRightOutlined from '@mui/icons-material/ChevronRightOutlined';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useBoardPresenceCurrent, useBoardPresenceFeed } from '@boardsesh/board-presence-react';
import { themeTokens } from '@/app/theme/theme-config';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { DEFAULT_GRADE_COLOR, getGradeTextColor } from '@/app/lib/grade-colors';

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
  const { formatGrade, getGradeColor } = useGradeFormat();
  const { currentClimb } = useBoardPresenceCurrent();
  const { history, stats } = useBoardPresenceFeed();

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

      <Box sx={{ overflowY: 'auto', flex: 1 }}>
        {currentClimb ? (
          <NowOnTheWallHero
            climb={currentClimb}
            formattedGrade={currentClimb.grade ? formatGrade(currentClimb.grade) : null}
            gradeColor={getGradeColor(currentClimb.grade) ?? DEFAULT_GRADE_COLOR}
            setByLine={(setter) => t('boardPresence.setByLine', { setter })}
            litByLine={(name) => t('boardPresence.litByLine', { name })}
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

        {history.length > 0 ? (
          <Box sx={{ px: 2, pb: 1 }}>
            <SectionHeader>{t('boardPresence.historyHeader')}</SectionHeader>
            <List disablePadding>
              {history.map((climb) => (
                <HistoryRow
                  key={`${climb.climbUuid}-${climb.seq}`}
                  climb={climb}
                  formattedGrade={climb.grade ? formatGrade(climb.grade) : null}
                  gradeColor={getGradeColor(climb.grade) ?? DEFAULT_GRADE_COLOR}
                  litByLine={(name) => t('boardPresence.litByLine', { name })}
                />
              ))}
            </List>
          </Box>
        ) : null}
      </Box>

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

function NowOnTheWallHero({ climb, formattedGrade, gradeColor, setByLine, litByLine }: HeroProps) {
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
        <Typography variant="caption" sx={{ display: 'block', color: 'var(--color-warning)' }} noWrap>
          {litByLine(litBy)}
        </Typography>
      ) : null}
    </Box>
  );
}

type HistoryRowProps = {
  climb: BoardPresenceClimb;
  formattedGrade: string | null;
  gradeColor: string;
  litByLine: (name: string) => string;
};

function HistoryRow({ climb, formattedGrade, gradeColor, litByLine }: HistoryRowProps) {
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
}
