'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MuiSelect, { type SelectChangeEvent } from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';

import type { BoardName } from '@/app/lib/types';
import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import { useBoardAngleOptions } from '@/app/hooks/use-board-angles';

export type BoardConfigSelectsProps = {
  selectedBoard: BoardName | undefined;
  selectedLayout: number | undefined;
  selectedSize: number | undefined;
  selectedSets: number[];
  selectedAngle: number;
  layouts: Array<{ id: number; name: string }>;
  sizes: Array<{ id: number; name: string; description?: string }>;
  sets: Array<{ id: number; name: string }>;
  onBoardChange: (board: BoardName) => void;
  onLayoutChange: (layoutId: number) => void;
  onSizeChange: (sizeId: number) => void;
  onSetsChange: (setIds: number[]) => void;
  onAngleChange: (angle: number) => void;
};

export default function BoardConfigSelects({
  selectedBoard,
  selectedLayout,
  selectedSize,
  selectedSets,
  selectedAngle,
  layouts,
  sizes,
  sets,
  onBoardChange,
  onLayoutChange,
  onSizeChange,
  onSetsChange,
  onAngleChange,
}: BoardConfigSelectsProps) {
  const { t } = useTranslation('boards');
  const angleOptions = useBoardAngleOptions(selectedBoard);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <FormControl fullWidth size="small">
        <InputLabel>{t('boardConfigSelects.board')}</InputLabel>
        <MuiSelect
          value={selectedBoard || ''}
          label={t('boardConfigSelects.board')}
          onChange={(e: SelectChangeEvent) => onBoardChange(e.target.value as BoardName)}
        >
          {SUPPORTED_BOARDS.map((board) => (
            <MenuItem key={board} value={board}>
              {board.charAt(0).toUpperCase() + board.slice(1)}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      <FormControl fullWidth size="small">
        <InputLabel>{t('boardConfigSelects.layout')}</InputLabel>
        <MuiSelect
          value={selectedLayout ?? ''}
          label={t('boardConfigSelects.layout')}
          onChange={(e: SelectChangeEvent<number | string>) => onLayoutChange(e.target.value as number)}
          disabled={!selectedBoard}
        >
          {layouts.map(({ id, name }) => (
            <MenuItem key={id} value={id}>
              {name}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      {selectedBoard !== 'moonboard' && (
        <FormControl fullWidth size="small">
          <InputLabel>{t('boardConfigSelects.size')}</InputLabel>
          <MuiSelect
            value={selectedSize ?? ''}
            label={t('boardConfigSelects.size')}
            onChange={(e: SelectChangeEvent<number | string>) => onSizeChange(e.target.value as number)}
            disabled={!selectedLayout}
          >
            {sizes.map(({ id, name, description }) => (
              <MenuItem key={id} value={id}>{`${name} ${description}`}</MenuItem>
            ))}
          </MuiSelect>
        </FormControl>
      )}

      <FormControl fullWidth size="small">
        <InputLabel>{t('boardConfigSelects.holdSets')}</InputLabel>
        <MuiSelect<number[]>
          multiple
          value={selectedSets}
          label={t('boardConfigSelects.holdSets')}
          onChange={(e) => onSetsChange(e.target.value as number[])}
          disabled={!selectedSize}
        >
          {sets.map(({ id, name }) => (
            <MenuItem key={id} value={id}>
              {name}
            </MenuItem>
          ))}
        </MuiSelect>
      </FormControl>

      <FormControl fullWidth size="small">
        <InputLabel>{t('boardConfigSelects.angle')}</InputLabel>
        <MuiSelect
          value={selectedAngle}
          label={t('boardConfigSelects.angle')}
          onChange={(e: SelectChangeEvent<number>) => onAngleChange(e.target.value)}
          disabled={!selectedBoard}
        >
          {selectedBoard &&
            angleOptions.map((angle) => (
              <MenuItem key={angle} value={angle}>
                {angle}
              </MenuItem>
            ))}
        </MuiSelect>
      </FormControl>
    </Box>
  );
}
