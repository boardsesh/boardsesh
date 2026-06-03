'use client';

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import MoonBoardRenderer from '../moonboard-renderer/moonboard-renderer';
import { useMoonBoardCreateClimb } from '@boardsesh/create-climb-react';
import HoldIndicator from '../create-climb/hold-indicator';
import HoldTypePicker from '../create-climb/hold-type-picker';
import { useHoldTypePicker } from '../create-climb/use-hold-type-picker';
import { themeTokens } from '@/app/theme/theme-config';
import { coordinateToHoldId, MOONBOARD_HOLD_STATES } from '@/app/lib/moonboard-config';
import { convertLitUpHoldsMapToMoonBoardHolds } from '@/app/lib/moonboard-climb-helpers';
import type { MoonBoardClimb, GridCoordinate } from '@boardsesh/moonboard-ocr/browser';
import type { LitUpHoldsMap } from '../board-renderer/types';
import styles from './moonboard-edit-modal.module.css';

type MoonBoardEditModalProps = {
  open: boolean;
  climb: MoonBoardClimb;
  layoutFolder: string;
  holdSetImages: string[];
  onSave: (updatedClimb: MoonBoardClimb) => void;
  onCancel: () => void;
};

/**
 * Convert OCR climb holds to the lit up holds map format
 */
function convertClimbToHoldsMap(climb: MoonBoardClimb): LitUpHoldsMap {
  const map: LitUpHoldsMap = {};

  climb.holds.start.forEach((coord) => {
    const holdId = coordinateToHoldId(coord);
    map[holdId] = {
      state: 'STARTING',
      color: MOONBOARD_HOLD_STATES.start.color,
      displayColor: MOONBOARD_HOLD_STATES.start.displayColor,
    };
  });

  climb.holds.hand.forEach((coord) => {
    const holdId = coordinateToHoldId(coord);
    map[holdId] = {
      state: 'HAND',
      color: MOONBOARD_HOLD_STATES.hand.color,
      displayColor: MOONBOARD_HOLD_STATES.hand.displayColor,
    };
  });

  climb.holds.finish.forEach((coord) => {
    const holdId = coordinateToHoldId(coord);
    map[holdId] = {
      state: 'FINISH',
      color: MOONBOARD_HOLD_STATES.finish.color,
      displayColor: MOONBOARD_HOLD_STATES.finish.displayColor,
    };
  });

  return map;
}

/**
 * Convert lit up holds map back to OCR hold format
 */
function convertHoldsMapToOcrFormat(holdsMap: LitUpHoldsMap): MoonBoardClimb['holds'] {
  const holds = convertLitUpHoldsMapToMoonBoardHolds(holdsMap);
  return {
    start: holds.start as GridCoordinate[],
    hand: holds.hand as GridCoordinate[],
    finish: holds.finish as GridCoordinate[],
  };
}

export default function MoonBoardEditModal({
  open,
  climb,
  layoutFolder,
  holdSetImages,
  onSave,
  onCancel,
}: MoonBoardEditModalProps) {
  const { t } = useTranslation('climbs');
  const [climbName, setClimbName] = useState(climb.name);

  const initialHoldsMap = convertClimbToHoldsMap(climb);

  const { litUpHoldsMap, setLitUpHoldsMap, setHoldState, startingCount, finishCount, handCount, totalHolds, isValid } =
    useMoonBoardCreateClimb({ initialHoldsMap });

  const picker = useHoldTypePicker({ litUpHoldsMap, setHoldState });

  // Reset to initial state when climb changes
  useEffect(() => {
    if (open) {
      const newHoldsMap = convertClimbToHoldsMap(climb);
      setLitUpHoldsMap(newHoldsMap);
      setClimbName(climb.name);
    }
  }, [climb, open, setLitUpHoldsMap]);

  const handleOk = () => {
    if (!climbName.trim()) return;
    const updatedClimb: MoonBoardClimb = {
      ...climb,
      name: climbName.trim(),
      holds: convertHoldsMapToOcrFormat(litUpHoldsMap),
    };
    onSave(updatedClimb);
  };

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth className={styles.modal}>
      <DialogTitle>{t('moonboardEditModal.title')}</DialogTitle>
      <DialogContent>
        <div className={styles.content}>
          <div className={styles.boardSection}>
            <MoonBoardRenderer
              layoutFolder={layoutFolder}
              holdSetImages={holdSetImages}
              litUpHoldsMap={litUpHoldsMap}
              onHoldClick={picker.handleHoldClick}
            />

            <HoldTypePicker
              boardName="moonboard"
              anchorEl={picker.anchorEl}
              currentState={picker.currentState}
              startingCount={startingCount}
              finishCount={finishCount}
              onSelect={picker.handleSelect}
              onClose={picker.handleClose}
            />

            <Stack direction="row" spacing={1.5} flexWrap="wrap" justifyContent="center" className={styles.holdCounts}>
              <HoldIndicator
                count={startingCount}
                max={2}
                color={themeTokens.colors.error}
                label={t('createClimbForm.holds.start')}
              />
              <HoldIndicator
                count={handCount}
                color={themeTokens.colors.primary}
                label={t('createClimbForm.holds.hand')}
              />
              <HoldIndicator
                count={finishCount}
                max={2}
                color={themeTokens.colors.success}
                label={t('createClimbForm.holds.finish')}
              />
              <HoldIndicator
                count={totalHolds}
                color={themeTokens.colors.secondary}
                label={t('createClimbForm.holds.total')}
              />
            </Stack>

            {!isValid && totalHolds > 0 && (
              <Typography variant="body2" component="span" color="text.secondary" className={styles.validationHint}>
                {t('createClimbForm.validation.needsStartFinish')}
              </Typography>
            )}
          </div>

          <div className={styles.formSection}>
            <TextField
              label={t('moonboardEditModal.nameLabel')}
              value={climbName}
              onChange={(e) => setClimbName(e.target.value)}
              required
              fullWidth
              size="small"
              placeholder={t('createClimbForm.namePlaceholder')}
              slotProps={{ htmlInput: { maxLength: 100 } }}
              error={!climbName.trim()}
              helperText={!climbName.trim() ? t('moonboardEditModal.nameRequired') : undefined}
            />

            <div className={styles.climbInfo}>
              <Typography variant="body2" component="span" color="text.secondary">
                {t('moonboardEditModal.setter', { setter: climb.setter || t('moonboardEditModal.unknown') })}
              </Typography>
              <Typography variant="body2" component="span" color="text.secondary">
                {t('moonboardEditModal.grade', { grade: climb.userGrade || t('moonboardEditModal.unknown') })}
              </Typography>
              <Typography variant="body2" component="span" color="text.secondary">
                {t('moonboardEditModal.angle', { angle: climb.angle })}
              </Typography>
            </div>
          </div>
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{t('common:actions.cancel')}</Button>
        <Button variant="contained" onClick={handleOk} disabled={!isValid}>
          {t('moonboardEditModal.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
