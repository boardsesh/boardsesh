'use client';

// Preset badge for the kiosk editor: the derived preset name (there is no
// picker — the preset IS the board count) plus a tiny CSS-grid diagram of the
// board area and, when enabled, the leaderboard rail. Also carries the
// quad+rail expectation-setting note: at 1080p each board gets ~740×420 px.

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { kioskPresetForBoardCount, type KioskPreset } from '@boardsesh/kiosk';
import { themeTokens } from '@/app/theme/theme-config';

// grid-template shorthand (<rows> / <columns>) per preset — the same shapes as
// kiosk-layout.module.css, at diagram scale.
const DIAGRAM_GRID_TEMPLATE: Record<KioskPreset, string> = {
  single: '1fr / 1fr',
  dual: '1fr / 1fr 1fr',
  triple: '1fr / 1fr 1fr 1fr',
  quad: '1fr 1fr / 1fr 1fr',
};

const PRESET_BOARD_COUNT: Record<KioskPreset, number> = { single: 1, dual: 2, triple: 3, quad: 4 };

function PresetDiagram({ preset, hasRail }: { preset: KioskPreset; hasRail: boolean }) {
  const cell = (
    <Box
      sx={{
        backgroundColor: 'var(--semantic-fill)',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '2px',
        minWidth: 0,
        minHeight: 0,
      }}
    />
  );
  return (
    <Box aria-hidden sx={{ display: 'flex', gap: '3px', width: 56, height: 32, flexShrink: 0 }}>
      <Box sx={{ display: 'grid', gridTemplate: DIAGRAM_GRID_TEMPLATE[preset], gap: '3px', flex: 1, minWidth: 0 }}>
        {Array.from({ length: PRESET_BOARD_COUNT[preset] }, (_, cellIndex) => (
          <React.Fragment key={cellIndex}>{cell}</React.Fragment>
        ))}
      </Box>
      {hasRail && (
        <Box
          sx={{
            width: 12,
            backgroundColor: 'action.focus',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '2px',
            flexShrink: 0,
          }}
        />
      )}
    </Box>
  );
}

type KioskLayoutBadgeProps = {
  boardCount: number;
  hasRail: boolean;
};

export default function KioskLayoutBadge({ boardCount, hasRail }: KioskLayoutBadgeProps) {
  const { t } = useTranslation('kiosk');
  const preset = kioskPresetForBoardCount(boardCount);

  if (preset === null) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Chip size="small" variant="outlined" label={t('manage.presets.none')} />
        <Typography variant="caption" color="text.secondary">
          {t('manage.editor.presetNoneHelper')}
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <PresetDiagram preset={preset} hasRail={hasRail} />
        <Chip
          size="small"
          color="primary"
          variant="outlined"
          label={t(`manage.presets.${preset}`)}
          sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}
        />
      </Box>
      {preset === 'quad' && hasRail && (
        <Typography variant="caption" color="text.secondary">
          {t('manage.editor.quadRailHint')}
        </Typography>
      )}
    </Box>
  );
}
