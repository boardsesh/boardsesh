'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import LightbulbOutlined from '@mui/icons-material/LightbulbOutlined';
import Celebration from '@mui/icons-material/Celebration';
import StopCircleOutlined from '@mui/icons-material/StopCircleOutlined';
import AutoAwesome from '@mui/icons-material/AutoAwesome';
import Palette from '@mui/icons-material/Palette';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import { useBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import { useCurrentClimb } from '../graphql-queue';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE } from '../board-renderer/types';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { GLYPHS, PARTY_LETTERS, buildPartyFrames, mapGlyphToHolds } from './party-glyphs';
import { CUSTOMISABLE_LED_ROLES, type CustomisableLedRole } from '@/app/lib/led-color-overrides-db';
import type { BoardName } from '@boardsesh/shared-schema';

const PARTY_TICK_MS = 600;
const DISCO_TICK_MS = 450;

type LightControlDrawerProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * Pull just the HAND-role placement IDs out of a frame string. Disco strobes
 * only the regular hand-hold (the "blue" holds in climbing convention) so
 * START/FOOT/FINISH stay at their canonical colours throughout — those are
 * the cues climbers actually rely on while sending the route.
 */
function extractHandPlacementIds(frames: string, boardName: BoardName): number[] {
  if (!frames) return [];
  const stateMap = HOLD_STATE_MAP[boardName];
  if (!stateMap) return [];
  const ids: number[] = [];
  for (const segment of frames.split('p')) {
    if (!segment) continue;
    const [placementStr, roleStr] = segment.split('r');
    const placementId = Number(placementStr);
    const roleCode = Number(roleStr);
    if (!Number.isFinite(placementId) || !Number.isFinite(roleCode)) continue;
    if (stateMap[roleCode]?.name === 'HAND') ids.push(placementId);
  }
  return ids;
}

/**
 * Default hex shown in the colour picker when the user hasn't customised this
 * role yet — the canonical role colour for the active board so the swatch
 * starts on whatever the LEDs are actually emitting.
 */
function getDefaultRoleColor(role: CustomisableLedRole, boardName: BoardName): string {
  const code = STATE_TO_PRIMARY_CODE[boardName]?.[role];
  if (code == null) return '#0000ff';
  return HOLD_STATE_MAP[boardName]?.[code]?.color ?? '#0000ff';
}

export const LightControlDrawer: React.FC<LightControlDrawerProps> = ({ open, onClose }) => {
  const { t } = useTranslation('common');
  const { showMessage } = useSnackbar();
  const {
    isConnected,
    sendFramesToBoard,
    clearBoard,
    boardDetails,
    partyMode,
    setPartyMode,
    ledColorOverrides,
    setLedColorOverrides,
  } = useBluetoothContext();
  const { currentClimbQueueItem } = useCurrentClimb();

  const isMoonboard = boardDetails.board_name === 'moonboard';
  const climbFrames = currentClimbQueueItem?.climb.frames ?? '';
  const climbMirrored = !!currentClimbQueueItem?.climb.mirrored;
  const hasClimbLoaded = climbFrames.length > 0;

  const [colorDialogOpen, setColorDialogOpen] = useState(false);

  // Pre-snap each unique letter's bitmap to hold IDs once per board config —
  // the snap is deterministic so we don't need to re-run it every tick.
  const lettersToHoldIds = useMemo(() => {
    if (isMoonboard) return new Map<string, number[]>();
    const map = new Map<string, number[]>();
    for (const letter of new Set(PARTY_LETTERS)) {
      const glyph = GLYPHS[letter];
      if (!glyph) continue;
      map.set(letter, mapGlyphToHolds(glyph, boardDetails));
    }
    return map;
  }, [boardDetails, isMoonboard]);

  // Cycle through the letters of "BOARDSESH", rotating through the board's
  // available role colours so each letter is visually distinct.
  useEffect(() => {
    if (partyMode !== 'glyphs' || !isConnected || isMoonboard) return;

    const stateCodes = Object.values(STATE_TO_PRIMARY_CODE[boardDetails.board_name] ?? {}).filter(
      (code): code is number => typeof code === 'number',
    );
    if (stateCodes.length === 0) return;

    let letterIndex = 0;
    const sendCurrentLetter = () => {
      const letter = PARTY_LETTERS[letterIndex % PARTY_LETTERS.length];
      const holdIds = lettersToHoldIds.get(letter) ?? [];
      const stateCode = stateCodes[letterIndex % stateCodes.length];
      void sendFramesToBoard(buildPartyFrames(holdIds, stateCode));
      letterIndex++;
    };
    sendCurrentLetter();
    const intervalId = window.setInterval(sendCurrentLetter, PARTY_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [partyMode, isConnected, isMoonboard, boardDetails.board_name, lettersToHoldIds, sendFramesToBoard]);

  // Disco mode: keep the START/FOOT/FINISH holds at their canonical colours
  // (so the climb stays readable) and re-roll only the HAND holds' colours
  // every tick. Placement IDs come straight from the climb's frames so
  // swapping climbs while the disco is running picks up the new holds on
  // the next tick.
  useEffect(() => {
    if (partyMode !== 'disco' || !isConnected) return;

    const stateCodes = Object.values(STATE_TO_PRIMARY_CODE[boardDetails.board_name] ?? {}).filter(
      (code): code is number => typeof code === 'number',
    );
    if (stateCodes.length === 0) return;

    const handPlacementIds = extractHandPlacementIds(climbFrames, boardDetails.board_name);
    if (handPlacementIds.length === 0) return;

    // Preserve the original frames for non-HAND holds — strip out only the
    // HAND segments and append fresh randomised role codes for them. Built
    // once per disco activation; the random roll happens inside the tick.
    const baseSegments: string[] = [];
    const stateMap = HOLD_STATE_MAP[boardDetails.board_name];
    if (stateMap) {
      for (const segment of climbFrames.split('p')) {
        if (!segment) continue;
        const [placementStr, roleStr] = segment.split('r');
        const roleCode = Number(roleStr);
        if (!Number.isFinite(roleCode)) continue;
        if (stateMap[roleCode]?.name === 'HAND') continue;
        baseSegments.push(`p${placementStr}r${roleStr}`);
      }
    }
    const baseFrames = baseSegments.join('');

    const sendDiscoFrame = () => {
      const handFrames = handPlacementIds
        .map((id) => `p${id}r${stateCodes[Math.floor(Math.random() * stateCodes.length)]}`)
        .join('');
      void sendFramesToBoard(`${baseFrames}${handFrames}`, climbMirrored);
    };
    sendDiscoFrame();
    const intervalId = window.setInterval(sendDiscoFrame, DISCO_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [partyMode, isConnected, boardDetails.board_name, climbFrames, climbMirrored, sendFramesToBoard]);

  // When any light show stops, the wall would otherwise stay frozen on the
  // last frame — clear it once so the board returns to a blank state. The
  // queue auto-sender resumes on the next render and repaints the climb.
  const lastPartyModeRef = useRef(partyMode);
  useEffect(() => {
    if (lastPartyModeRef.current !== 'off' && partyMode === 'off' && isConnected) {
      void clearBoard();
    }
    lastPartyModeRef.current = partyMode;
  }, [partyMode, isConnected, clearBoard]);

  const handleClearAll = async () => {
    // When a light show is active, the stop effect already issues a
    // clearBoard() once partyMode flips off — calling clearBoard()
    // here too would double up the BLE write for one tap.
    if (partyMode !== 'off') {
      setPartyMode('off');
      return;
    }
    try {
      const success = await clearBoard();
      if (!success) {
        showMessage(t('lightControl.clearFailed'), 'error');
      }
    } catch (error) {
      // sendFramesToBoard normally catches BLE errors and returns false,
      // but a disconnect mid-write can still surface a rejected promise.
      console.error('Failed to clear board lights:', error);
      showMessage(t('lightControl.clearFailed'), 'error');
    }
  };

  const handlePartyToggle = () => {
    if (isMoonboard) {
      showMessage(t('lightControl.partyUnsupported'), 'info');
      return;
    }
    setPartyMode(partyMode === 'glyphs' ? 'off' : 'glyphs');
  };

  const handleDiscoToggle = () => {
    if (!hasClimbLoaded) {
      showMessage(t('lightControl.discoNeedsClimb'), 'info');
      return;
    }
    setPartyMode(partyMode === 'disco' ? 'off' : 'disco');
  };

  const handleColorChange = (role: CustomisableLedRole, hex: string) => {
    setLedColorOverrides({ ...ledColorOverrides, [role]: hex });
  };

  const handleColorReset = () => {
    setLedColorOverrides({});
  };

  return (
    <>
      <SwipeableDrawer placement="bottom" open={open} onClose={onClose} title={t('lightControl.title')} height="auto">
        <List disablePadding>
          <ListItemButton onClick={handleClearAll} disabled={!isConnected}>
            <ListItemIcon>
              <LightbulbOutlined />
            </ListItemIcon>
            <ListItemText primary={t('lightControl.turnOffAll')} />
          </ListItemButton>
          <ListItemButton onClick={handleDiscoToggle} disabled={!isConnected || !hasClimbLoaded}>
            <ListItemIcon>{partyMode === 'disco' ? <StopCircleOutlined /> : <AutoAwesome />}</ListItemIcon>
            <ListItemText
              primary={partyMode === 'disco' ? t('lightControl.stopDisco') : t('lightControl.discoMode')}
              secondary={!hasClimbLoaded ? t('lightControl.discoNeedsClimb') : undefined}
            />
          </ListItemButton>
          <ListItemButton onClick={handlePartyToggle} disabled={!isConnected || isMoonboard}>
            <ListItemIcon>{partyMode === 'glyphs' ? <StopCircleOutlined /> : <Celebration />}</ListItemIcon>
            <ListItemText
              primary={partyMode === 'glyphs' ? t('lightControl.stopParty') : t('lightControl.partyMode')}
              secondary={isMoonboard ? t('lightControl.partyUnsupported') : undefined}
            />
          </ListItemButton>
          <ListItemButton onClick={() => setColorDialogOpen(true)} disabled={isMoonboard}>
            <ListItemIcon>
              <Palette />
            </ListItemIcon>
            <ListItemText
              primary={t('lightControl.customizeColors')}
              secondary={isMoonboard ? t('lightControl.customizeColorsUnsupported') : undefined}
            />
          </ListItemButton>
        </List>
      </SwipeableDrawer>
      <Dialog open={colorDialogOpen} onClose={() => setColorDialogOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>{t('lightControl.customizeColorsTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('lightControl.customizeColorsHelp')}
          </Typography>
          <Stack spacing={2}>
            {CUSTOMISABLE_LED_ROLES.map((role) => {
              const fallback = getDefaultRoleColor(role, boardDetails.board_name);
              const value = ledColorOverrides[role] ?? fallback;
              return (
                <Box key={role} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body1">{t(`lightControl.role.${role}`)}</Typography>
                  <Box
                    component="input"
                    type="color"
                    value={value}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                      handleColorChange(role, event.target.value)
                    }
                    sx={{
                      width: 56,
                      height: 40,
                      border: 'none',
                      padding: 0,
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                    aria-label={t(`lightControl.role.${role}`)}
                  />
                </Box>
              );
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleColorReset}>{t('lightControl.resetColors')}</Button>
          <Button onClick={() => setColorDialogOpen(false)} variant="contained">
            {t('actions.done')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
