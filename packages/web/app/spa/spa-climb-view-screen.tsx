'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { useBoardBluetooth } from '@/app/components/board-bluetooth-control/use-board-bluetooth';
import { useSpaClimb } from './hooks/use-spa-climb';
import type { SpaBoard } from './hooks/use-spa-board';

type SpaClimbViewScreenProps = {
  spaBoard: SpaBoard;
  climbUuid: string;
  onBackToList: () => void;
};

/** Climb view: board with holds lit, plus a minimal "light up the board"
 * control built directly on useBoardBluetooth. Deliberately skips the full
 * BluetoothProvider (party mode, wall presence, session reporting) — those
 * assume a persistent session/queue this experiment doesn't have. */
export function SpaClimbViewScreen({ spaBoard, climbUuid, onBackToList }: SpaClimbViewScreenProps) {
  const { t } = useTranslation('climbs');
  const { boardDetails, parsedParams } = spaBoard;
  const { data: climb, isLoading } = useSpaClimb(parsedParams, climbUuid);
  const { isConnected, loading, connect, sendFramesToBoard } = useBoardBluetooth({ boardDetails });

  const handleLightUp = () => {
    if (!climb) return;
    const mirrored = !!climb.mirrored;
    if (isConnected) {
      void sendFramesToBoard(climb.frames, mirrored);
    } else {
      void connect(climb.frames, mirrored);
    }
  };

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!climb) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography>{t('spa.notFound')}</Typography>
        <Button onClick={onBackToList}>{t('spa.backToList')}</Button>
      </Box>
    );
  }

  const litUpHoldsMap = convertLitUpHoldsStringToMap(climb.frames, boardDetails.board_name)[0];

  return (
    <Box sx={{ p: 2 }}>
      <Button onClick={onBackToList} sx={{ mb: 2 }}>
        {t('spa.backToList')}
      </Button>
      <Typography variant="h5">{climb.name}</Typography>
      <Typography variant="body2" color="text.secondary">
        {climb.difficulty} · {climb.setter_username}
      </Typography>
      <Box sx={{ my: 2 }}>
        <BoardRenderer
          boardDetails={boardDetails}
          litUpHoldsMap={litUpHoldsMap}
          mirrored={!!climb.mirrored}
          fillHeight
        />
      </Box>
      <Button variant="contained" onClick={handleLightUp} disabled={loading}>
        {isConnected ? t('spa.lightUpClimb') : t('spa.connectAndLightUp')}
      </Button>
    </Box>
  );
}
