'use client';

import React from 'react';
import dynamic from 'next/dynamic';
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
import type { ChartData } from '../profile-stats-charts';
import {
  type TimeframeType,
  type LogbookEntry,
  boardOptions,
  timeframeOptions,
} from '../utils/profile-constants';
import styles from '../profile-page.module.css';

const ProfileStatsCharts = dynamic(() => import('../profile-stats-charts'), {
  ssr: false,
  loading: () => (
    <div className={styles.loadingStats}>
      <CircularProgress />
    </div>
  ),
});

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
  chartDataBar: ChartData | null;
  chartDataPie: ChartData | null;
  chartDataWeeklyBar: ChartData | null;
  isOwnProfile: boolean;
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
  chartDataBar,
  chartDataPie,
  chartDataWeeklyBar,
  isOwnProfile,
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
          <Stack direction="row" spacing={1} alignItems="center">
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
        <div className={styles.chartsContainer}>
          <ProfileStatsCharts
            chartDataAggregated={null}
            chartDataWeeklyBar={chartDataWeeklyBar}
            chartDataBar={chartDataBar}
            chartDataPie={chartDataPie}
          />
        </div>
      )}
    </CardContent></MuiCard>
  );
}
