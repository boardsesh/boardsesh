'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Slider from '@mui/material/Slider';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { CncArtworkMode, CncArtworkRules } from '@boardsesh/shared-schema';
import { themeTokens } from '@/app/theme/theme-config';
import styles from '../build-plans.module.css';
import {
  CNC_ARTWORK_MODES,
  CNC_MAX_ROTATION_DEG,
  CNC_MIN_ROTATION_DEG,
  artworkIssues,
  type CncArtworkDraft,
} from './configurator-state';
import type { CncLayoutPanel } from './layout-summary';
import PlacementForm from './placement-form';
import type { CncArtworkCollision } from './use-cnc-artwork-validation';

/**
 * Routed text labels: add one, say what it reads, and put it somewhere.
 *
 * Two verdicts run side by side and they are not interchangeable. The local one
 * (`artworkIssues`) answers "is this field filled in sensibly" instantly, from
 * the catalogue's published bounds. The generator's one answers "will this
 * actually cut" — the only question that matters — and it is what gates Buy.
 * The local check exists so somebody typing a 2000 mm width does not need a
 * round trip to learn it is too wide; it never stands in for the other.
 *
 * Uploads land in a later change; a label is the half of artwork that needs no
 * file, and it is what most buyers want anyway.
 */

/** How many degrees one nudge of the rotation slider moves. */
const ROTATION_STEP_DEG = 5;

/** Slider granularity for width. Finer than a router bit can hold; coarse enough to drag. */
const WIDTH_STEP_MM = 5;

export type ArtworkStepProps = {
  artwork: readonly CncArtworkDraft[];
  rules: CncArtworkRules;
  /** Typeface keys from the catalogue, default first. */
  fonts: readonly string[];
  panels: readonly CncLayoutPanel[];
  /** The generator's verdict, or null when there is no answer — see `useCncArtworkValidation`. */
  validationOk: boolean | null;
  collisions: readonly CncArtworkCollision[];
  isChecking: boolean;
  /** False when nobody is signed in, so the generator has not been asked at all. */
  canValidate: boolean;
  onAdd: () => void;
  onChange: (id: string, patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
  onRemove: (id: string) => void;
};

export default function ArtworkStep({
  artwork,
  rules,
  fonts,
  panels,
  validationOk,
  collisions,
  isChecking,
  canValidate,
  onAdd,
  onChange,
  onRemove,
}: ArtworkStepProps) {
  const { t } = useTranslation('cnc');
  const isFull = artwork.length >= rules.maxItems;

  return (
    <Box>
      <Typography variant="subtitle1" className={styles.stepHeading}>
        {t('configurator.artwork.heading')}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {t('configurator.artwork.help')}
      </Typography>

      <Stack spacing={2} sx={{ mt: 2 }}>
        {artwork.map((item, index) => (
          <ArtworkItemFields
            key={item.id}
            item={item}
            // The index the generator reports collisions against: it is the
            // position in the SUBMITTED list, and an item with no text yet is
            // not submitted. Counting only the ready items above this one is
            // what keeps a half-typed label from shifting somebody else's
            // collision onto the wrong card.
            submittedIndex={artwork.slice(0, index).filter((earlier) => earlier.text.trim().length > 0).length}
            isSubmitted={item.text.trim().length > 0}
            rules={rules}
            fonts={fonts}
            panels={panels}
            collisions={collisions}
            onChange={(patch) => onChange(item.id, patch)}
            onRemove={() => onRemove(item.id)}
          />
        ))}

        <Box>
          <Button variant="outlined" onClick={onAdd} disabled={isFull} sx={{ textTransform: 'none' }}>
            {t('configurator.artwork.add')}
          </Button>
          <FormHelperText>
            {isFull
              ? t('configurator.artwork.full', { count: rules.maxItems })
              : t('configurator.artwork.remaining', { count: rules.maxItems - artwork.length })}
          </FormHelperText>
        </Box>

        {artwork.length > 0 && (
          <ArtworkVerdict
            validationOk={validationOk}
            isChecking={isChecking}
            canValidate={canValidate}
            hasCollisions={collisions.length > 0}
          />
        )}
      </Stack>
    </Box>
  );
}

/**
 * One line saying whether the wall will actually take this artwork.
 *
 * "Not checked yet" is its own state rather than being folded into a pass. A
 * signed-out buyer has had nothing verified, and saying so is what makes the
 * sign-in prompt on Buy make sense when they get there.
 */
function ArtworkVerdict({
  validationOk,
  isChecking,
  canValidate,
  hasCollisions,
}: {
  validationOk: boolean | null;
  isChecking: boolean;
  canValidate: boolean;
  hasCollisions: boolean;
}) {
  const { t } = useTranslation('cnc');

  if (isChecking) {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          {t('configurator.artwork.checking')}
        </Typography>
      </Stack>
    );
  }

  if (!canValidate) {
    return <Alert severity="info">{t('configurator.artwork.signInToCheck')}</Alert>;
  }

  if (validationOk === true) return <Alert severity="success">{t('configurator.artwork.fits')}</Alert>;
  if (validationOk === false && hasCollisions) return null; // Each card already says what is wrong.
  if (validationOk === false) return <Alert severity="error">{t('configurator.artwork.doesNotFit')}</Alert>;
  return null;
}

function ArtworkItemFields({
  item,
  submittedIndex,
  isSubmitted,
  rules,
  fonts,
  panels,
  collisions,
  onChange,
  onRemove,
}: {
  item: CncArtworkDraft;
  submittedIndex: number;
  isSubmitted: boolean;
  rules: CncArtworkRules;
  fonts: readonly string[];
  panels: readonly CncLayoutPanel[];
  collisions: readonly CncArtworkCollision[];
  onChange: (patch: Partial<Omit<CncArtworkDraft, 'id'>>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('cnc');
  const issues = artworkIssues(item, rules);
  const itemCollisions = isSubmitted ? collisions.filter((collision) => collision.artworkIndex === submittedIndex) : [];

  return (
    <Box className={styles.artworkItem}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" className={styles.artworkItemHeader}>
        <Typography variant="body2" fontWeight={themeTokens.typography.fontWeight.semibold}>
          {t('configurator.artwork.itemLabel', { number: submittedIndex + 1 })}
        </Typography>
        <Button size="small" color="error" onClick={onRemove} sx={{ textTransform: 'none' }}>
          {t('configurator.artwork.remove')}
        </Button>
      </Stack>

      <Stack spacing={2} sx={{ mt: 1 }}>
        <TextField
          label={t('configurator.artwork.text')}
          helperText={t('configurator.artwork.textHelp', { max: rules.maxTextChars })}
          value={item.text}
          onChange={(event) => onChange({ text: event.target.value })}
          error={issues.includes('textTooLong')}
          size="small"
          fullWidth
          slotProps={{ htmlInput: { maxLength: rules.maxTextChars } }}
        />

        <Box className={styles.optionGrid}>
          <FormControl fullWidth size="small">
            <InputLabel id={`cnc-artwork-font-${item.id}`}>{t('configurator.artwork.font')}</InputLabel>
            <Select
              labelId={`cnc-artwork-font-${item.id}`}
              label={t('configurator.artwork.font')}
              value={item.font}
              onChange={(event) => onChange({ font: event.target.value })}
            >
              {fonts.map((font) => (
                <MenuItem key={font} value={font}>
                  {/* i18n-keep cnc:configurator.artwork.fonts.liberation-sans */}
                  {t(`configurator.artwork.fonts.${font}`, { defaultValue: font })}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>{t('configurator.artwork.fontHelp')}</FormHelperText>
          </FormControl>

          <FormControl fullWidth size="small">
            <InputLabel id={`cnc-artwork-mode-${item.id}`}>{t('configurator.artwork.mode')}</InputLabel>
            <Select
              labelId={`cnc-artwork-mode-${item.id}`}
              label={t('configurator.artwork.mode')}
              value={item.mode}
              onChange={(event) => onChange({ mode: event.target.value as CncArtworkMode })}
            >
              {CNC_ARTWORK_MODES.map((mode) => (
                <MenuItem key={mode} value={mode}>
                  {/* i18n-keep cnc:configurator.artwork.modes.engrave */}
                  {t(`configurator.artwork.modes.${mode}.label`)}
                </MenuItem>
              ))}
            </Select>
            {/* i18n-keep cnc:configurator.artwork.modes.cut_through.help */}
            <FormHelperText>{t(`configurator.artwork.modes.${item.mode}.help`)}</FormHelperText>
          </FormControl>
        </Box>

        <Box>
          <Typography variant="body2" id={`cnc-artwork-width-${item.id}`}>
            {t('configurator.artwork.width', { width: item.widthMm })}
          </Typography>
          <Slider
            aria-labelledby={`cnc-artwork-width-${item.id}`}
            value={item.widthMm}
            min={rules.minWidthMm}
            max={rules.maxWidthMm}
            step={WIDTH_STEP_MM}
            onChange={(_event, value) => onChange({ widthMm: Array.isArray(value) ? value[0] : value })}
          />
          <FormHelperText>{t('configurator.artwork.widthHelp')}</FormHelperText>
        </Box>

        <Box>
          <Typography variant="body2" id={`cnc-artwork-rotation-${item.id}`}>
            {t('configurator.artwork.rotation', { degrees: item.rotationDeg })}
          </Typography>
          <Slider
            aria-labelledby={`cnc-artwork-rotation-${item.id}`}
            value={item.rotationDeg}
            min={CNC_MIN_ROTATION_DEG}
            max={CNC_MAX_ROTATION_DEG}
            step={ROTATION_STEP_DEG}
            onChange={(_event, value) => onChange({ rotationDeg: Array.isArray(value) ? value[0] : value })}
          />
        </Box>

        <PlacementForm item={item} panels={panels} onChange={onChange} />

        {issues.map((issue) => (
          // i18n-keep cnc:configurator.artwork.issues.textTooLong
          <Alert key={issue} severity="warning">
            {t(`configurator.artwork.issues.${issue}`, {
              min: rules.minWidthMm,
              max: rules.maxWidthMm,
              chars: rules.maxTextChars,
            })}
          </Alert>
        ))}

        {itemCollisions.map((collision, index) => (
          <Alert key={`${collision.kind}-${String(index)}`} severity="error">
            {/* i18n-keep cnc:configurator.artwork.collisions.off_panel */}
            {t(`configurator.artwork.collisions.${collision.kind}`, {
              defaultValue: t('configurator.artwork.collisions.unknown'),
            })}
          </Alert>
        ))}
      </Stack>
    </Box>
  );
}
