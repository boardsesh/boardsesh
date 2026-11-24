'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Typography from '@mui/material/Typography';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ToggleButton from '@mui/material/ToggleButton';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import { DatePicker as MuiDatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs from 'dayjs';
import DatePickerProvider from '@/app/components/form/date-picker-provider';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import {
  type UnifiedTimeframeType,
  unifiedTimeframeOptions,
  boardOptions,
} from '@/app/profile/[user_id]/utils/profile-constants';

type StatsFilterDrawerProps = {
  open: boolean;
  onClose: () => void;
  selectedBoard: string;
  onBoardChange: (board: string) => void;
  timeframe: UnifiedTimeframeType;
  onTimeframeChange: (timeframe: UnifiedTimeframeType) => void;
  fromDate: string;
  onFromDateChange: (date: string) => void;
  toDate: string;
  onToDateChange: (date: string) => void;
  onTransitionEnd?: (open: boolean) => void;
};

export default function StatsFilterDrawer({
  open,
  onClose,
  selectedBoard,
  onBoardChange,
  timeframe,
  onTimeframeChange,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  onTransitionEnd,
}: StatsFilterDrawerProps) {
  const { t } = useTranslation('profile');
  return (
    <SwipeableDrawer
      open={open}
      onClose={onClose}
      placement="top"
      title={t('filter.drawer.title')}
      onTransitionEnd={onTransitionEnd}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, pb: 2 }}>
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
            {t('filter.drawer.board')}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={selectedBoard}
            onChange={(_, val) => {
              if (val) onBoardChange(val as string);
            }}
            fullWidth
          >
            {boardOptions.map((opt) => (
              <ToggleButton key={opt.value} value={opt.value}>
                {opt.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
            {t('filter.drawer.timeRange')}
          </Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={timeframe}
            onChange={(_, val) => {
              if (val) onTimeframeChange(val as UnifiedTimeframeType);
            }}
            fullWidth
            sx={{ flexWrap: 'wrap' }}
          >
            {unifiedTimeframeOptions.map((opt) => (
              <ToggleButton key={opt.value} value={opt.value}>
                {opt.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        {timeframe === 'custom' && (
          <DatePickerProvider>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <MuiDatePicker
                value={fromDate ? dayjs(fromDate) : null}
                onChange={(val) => onFromDateChange(val ? val.format('YYYY-MM-DD') : '')}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
                label={t('filter.drawer.from')}
              />
              <MuiDatePicker
                value={toDate ? dayjs(toDate) : null}
                onChange={(val) => onToDateChange(val ? val.format('YYYY-MM-DD') : '')}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
                label={t('filter.drawer.to')}
              />
            </Stack>
          </DatePickerProvider>
        )}
      </Box>
    </SwipeableDrawer>
  );
}
