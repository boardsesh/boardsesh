'use client';

import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  formatGymReportingTime,
  gymReachCards,
  gymReachTrend,
  type GymTrendMetric,
  type GymTrendSelection,
} from '@boardsesh/graphql';
import type { GymReachOverview, GymStats } from '@boardsesh/shared-schema';
import SelectedCheck from '@/app/components/ui/selected-check';

type Props = { stats: GymStats; overview: GymReachOverview; selection: GymTrendSelection };

export function GymReachReport({ stats, overview, selection }: Props) {
  const { t, i18n } = useTranslation('boards');
  const locale = i18n.language || 'en-US';
  const cards = gymReachCards(stats, overview, locale, t);
  const { bars, selected } = gymReachTrend(overview.weeklyTrend, selection.metric, selection.week, locale, t);

  return (
    <Box sx={{ display: 'grid', gap: 3, minWidth: 0 }}>
      <Box
        sx={{
          display: 'grid',
          gap: 1,
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' },
        }}
      >
        {cards.map((card) => (
          <Box
            key={card.key}
            component="section"
            sx={{
              display: 'grid',
              alignContent: 'start',
              gap: 0.75,
              p: 2,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'background.paper',
            }}
          >
            <Typography component="h3" variant="subtitle2">
              {card.title}
            </Typography>
            <Typography variant="h4" component="p" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {card.value}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {card.description}
            </Typography>
            {card.note && (
              <Typography variant="caption" color="text.secondary">
                {card.note}
              </Typography>
            )}
            <Typography variant="caption">{card.comparison}</Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="body2" color="text.secondary">
        {overview.observationStartedAt
          ? t('gymReach.coverageFrom', {
              date: formatGymReportingTime(overview.observationStartedAt, stats.timeZone, locale),
            })
          : t('gymReach.coverageUnknown')}
      </Typography>
      <Box component="section" sx={{ display: 'grid', gap: 1.5, minWidth: 0 }}>
        <Typography component="h3" variant="h6">
          {t('gymReach.trend')}
        </Typography>
        <Box>
          <ToggleButtonGroup
            size="small"
            value={selection.metric}
            exclusive
            aria-label={t('gymReach.trendMetric')}
            onChange={(_event, next: GymTrendMetric | null) => {
              if (next) selection.setMetric(next);
            }}
          >
            <ToggleButton value="climbers" sx={{ gap: 0.5 }}>
              {selection.metric === 'climbers' && <SelectedCheck />}
              {t('gymReach.trendClimbers')}
            </ToggleButton>
            <ToggleButton value="sends" sx={{ gap: 0.5 }}>
              {selection.metric === 'sends' && <SelectedCheck />}
              {t('gymReach.trendSends')}
            </ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <Box sx={{ overflowX: 'auto', minWidth: 0, p: 0.5 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(12, minmax(64px, 1fr))',
              gap: 0.5,
              minWidth: 'max-content',
            }}
          >
            {bars.map((bar) => (
              <ButtonBase
                key={bar.key}
                aria-label={bar.accessibilityLabel}
                aria-pressed={selected?.key === bar.key}
                onFocus={() => selection.setWeek(bar.key)}
                onClick={() => selection.setWeek(bar.key)}
                sx={{
                  display: 'grid',
                  alignContent: 'start',
                  alignItems: 'end',
                  gap: 0.5,
                  p: 0.5,
                  borderRadius: 1,
                  minHeight: 48,
                  color: 'text.primary',
                  '&[aria-pressed=true]': { bgcolor: 'action.selected' },
                  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                <Box
                  aria-hidden
                  sx={{
                    display: 'flex',
                    alignItems: 'end',
                    justifyContent: 'center',
                    width: '100%',
                    height: 92,
                    borderBottom: 1,
                    borderColor: 'divider',
                  }}
                >
                  {bar.fraction > 0 && (
                    <Box
                      sx={{
                        width: '55%',
                        height: `${bar.fraction * 100}%`,
                        minHeight: 2,
                        bgcolor: 'primary.main',
                        borderTopLeftRadius: 2,
                        borderTopRightRadius: 2,
                        opacity: bar.coverage ? 0.6 : 1,
                      }}
                    />
                  )}
                </Box>
                <Typography variant="caption" component="span">
                  {bar.label}
                </Typography>
                {bar.progress && (
                  <Typography variant="caption" component="span">
                    {bar.progress}
                  </Typography>
                )}
                {bar.coverage && (
                  <Typography variant="caption" component="span" color="text.secondary">
                    {bar.coverage}
                  </Typography>
                )}
              </ButtonBase>
            ))}
          </Box>
        </Box>
        {selected && (
          <Typography variant="body2" aria-live="polite">
            {selected.accessibilityLabel}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
