'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import styles from '../build-plans.module.css';
import type { CncArtworkDraft } from './configurator-state';
import type { CncLayoutPanel } from './layout-summary';

/**
 * Where one piece of artwork sits, as three numbers and a panel.
 *
 * Its own component because it is the piece that goes away: the drag editor
 * replaces this form with a wall the buyer moves the label around on. Keeping
 * the numeric fields out of `artwork-step.tsx` means that swap is one import,
 * and it keeps a typed-in placement available as the fallback for anyone
 * without a pointer.
 */

export type PlacementFormProps = {
  item: CncArtworkDraft;
  /** Panels from the layout response. Empty while the layout is still loading. */
  panels: readonly CncLayoutPanel[];
  onChange: (patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
};

/** The label for one panel: the generator's own id where it sent one, the index otherwise. */
function panelLabel(panel: CncLayoutPanel, kickerLabel: string): string {
  const name = panel.id ?? String(panel.index + 1);
  return panel.role === 'kicker' ? `${name} · ${kickerLabel}` : name;
}

/**
 * Read a number out of a text field.
 *
 * Returns null for anything unparseable, which the caller drops rather than
 * writing as `NaN`: a NaN millimetre survives JSON, reaches the generator's
 * geometry and poisons it, and it is far easier to refuse here than to explain
 * there. An empty field is left alone for the same reason — someone clearing a
 * value to retype it has not asked for a placement at zero.
 */
function readNumberField(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function PlacementForm({ item, panels, onChange }: PlacementFormProps) {
  const { t } = useTranslation('cnc');

  return (
    <Box className={styles.optionGrid}>
      <FormControl fullWidth size="small" disabled={panels.length === 0}>
        <InputLabel id={`cnc-artwork-panel-${item.id}`}>{t('configurator.artwork.panel')}</InputLabel>
        <Select
          labelId={`cnc-artwork-panel-${item.id}`}
          label={t('configurator.artwork.panel')}
          value={panels.length === 0 ? '' : String(item.panelIndex)}
          onChange={(event) => onChange({ panelIndex: Number(event.target.value) })}
        >
          {panels.map((panel) => (
            <MenuItem key={panel.index} value={String(panel.index)}>
              {panelLabel(panel, t('configurator.artwork.kickerPanel'))}
            </MenuItem>
          ))}
        </Select>
        <FormHelperText>
          {panels.length === 0 ? t('configurator.artwork.panelLoading') : t('configurator.artwork.panelHelp')}
        </FormHelperText>
      </FormControl>

      <TextField
        label={t('configurator.artwork.x')}
        helperText={t('configurator.artwork.xHelp')}
        type="number"
        size="small"
        fullWidth
        value={String(item.xMm)}
        onChange={(event) => {
          const value = readNumberField(event.target.value);
          if (value !== null) onChange({ xMm: value });
        }}
      />

      <TextField
        label={t('configurator.artwork.y')}
        helperText={t('configurator.artwork.yHelp')}
        type="number"
        size="small"
        fullWidth
        value={String(item.yMm)}
        onChange={(event) => {
          const value = readNumberField(event.target.value);
          if (value !== null) onChange({ yMm: value });
        }}
      />
    </Box>
  );
}
