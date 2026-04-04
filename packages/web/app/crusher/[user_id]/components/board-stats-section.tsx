'use client';

import React from 'react';
import MuiCard from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import CircularProgress from '@mui/material/CircularProgress';
import { DatePicker as MuiDatePicker } from '@mui/x-date-pickers/DatePicker';
import { EmptyState } from '@/app/components/ui/empty-state';
import BoardImportPrompt from '@/app/components/settings/board-import-prompt';
import dayjs from 'dayjs';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import type { CssBarChartBar } from '@/app/components/charts/css-bar-chart';
import {
  type TimeframeType,
  type LogbookEntry,
  boardOptions,
  timeframeOptions,
} from '../utils/profile-constants';
import styles from '../profile-page.module.css';

interface BoardStatsSectionProps {
  selectedBoard: string;
  onBoardChange: (board: string) => void;
  timeframe: TimeframeType;
  onTimeframeChange: (timeframe: TimeframeType) => void;
  fromDate: string;
  onFromDateChange: (date: string) => void;
  toDate: string;
  onToDateChange: (date: string) => void;
  loadingStats: boolean;
  filteredLogbook: LogbookEntry[];
  weeklyBars: CssBarChartBar[] | null;
  isOwnProfile: boolean;
  weeklyFromDate: string;
  onWeeklyFromDateChange: (date: string) => void;
  weeklyToDate: string;
  onWeeklyToDateChange: (date: string) => void;
}

export default function BoardStatsSection({
  selectedBoard,
  onBoardChange,
  timeframe,
  onTimeframeChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  loadingStats,
  filteredLogbook,
  weeklyBars,
  isOwnProfile,
  weeklyFromDate,
  onWeeklyFromDateChange,
  weeklyToDate,
  onWeeklyToDateChange,
}: BoardStatsSectionProps) {
  return (
    <MuiCard className={styles.statsCard}><CardContent>
      <Typography variant="h6" component="h5">Board Stats</Typography>

      {/* Board Selector */}
      <div className={styles.boardSelector}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={selectedBoard}
          onChange={(_, val) => { if (val) onBoardChange(val as string); }}
        >
          {boardOptions.map((opt) => (
            <ToggleButton key={opt.value} value={opt.value}>{opt.label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      {/* Timeframe Selector */}
      <div className={styles.timeframeSelector}>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={timeframe}
          onChange={(_, val) => { if (val) onTimeframeChange(val as TimeframeType); }}
        >
          {timeframeOptions.map((opt) => (
            <ToggleButton key={opt.value} value={opt.value}>{opt.label}</ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      {timeframe === 'custom' && (
        <div className={styles.customDateRange}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }}>
            <Typography variant="body2" component="span">From:</Typography>
            <MuiDatePicker
              value={fromDate ? dayjs(fromDate) : null}
              onChange={(val) => onFromDateChange(val ? val.format('YYYY-MM-DD') : '')}
              slotProps={{ textField: { size: 'small' } }}
            />
            <Typography variant="body2" component="span">To:</Typography>
            <MuiDatePicker
              value={toDate ? dayjs(toDate) : null}
              onChange={(val) => onToDateChange(val ? val.format('YYYY-MM-DD') : '')}
              slotProps={{ textField: { size: 'small' } }}
            />
          </Stack>
        </div>
      )}

      {loadingStats ? (
        <div className={styles.loadingStats}>
          <CircularProgress />
        </div>
      ) : filteredLogbook.length === 0 ? (
        isOwnProfile && (selectedBoard === 'kilter' || selectedBoard === 'tension') ? (
          <BoardImportPrompt boardType={selectedBoard} />
        ) : (
          <EmptyState description="No climbing data for this period" />
        )
      ) : (
        <div className={styles.boardChartsContainer}>
          {/* Weekly Attempts */}
          {weeklyBars && (
            <div className={styles.boardChartSection}>
              <Typography variant="body2" component="span" fontWeight={600} className={styles.boardChartTitle}>
                Weekly Attempts
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ xs: 'stretch', sm: 'center' }} className={styles.weeklyDateRange}>
                <MuiDatePicker
                  value={weeklyFromDate ? dayjs(weeklyFromDate) : null}
                  onChange={(val) => onWeeklyFromDateChange(val ? val.format('YYYY-MM-DD') : '')}
                  slotProps={{ textField: { size: 'small' } }}
                  label="From"
                />
                <MuiDatePicker
                  value={weeklyToDate ? dayjs(weeklyToDate) : null}
                  onChange={(val) => onWeeklyToDateChange(val ? val.format('YYYY-MM-DD') : '')}
                  slotProps={{ textField: { size: 'small' } }}
                  label="To"
                />
              </Stack>
              <CssBarChart bars={weeklyBars} height={180} mobileHeight={120} gap={3} ariaLabel="Weekly attempts by difficulty" angledLabels maxLabels={12} />
            </div>
          )}

        </div>
      )}
    </CardContent></MuiCard>
  );
}
