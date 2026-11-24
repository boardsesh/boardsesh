'use client';

import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Select, { type SelectChangeEvent } from '@mui/material/Select';
import Typography from '@mui/material/Typography';
import {
  setupAngleLabel,
  setupLayoutLabel,
  setupSelectionOptions,
  setupSelectionReducer,
  setupSizeLabel,
  type SetupSelection,
  type SetupSelectionAction,
} from '@boardsesh/board-config';
import { MOONBOARD_WIDE_ANGLES_FLAG } from '@/app/flags';
import { useFeatureFlag } from '@/app/components/providers/feature-flags-provider';

type SetupSuggestionFieldsProps = {
  /** What the fields show: the climber's pick, or the board's current setup. */
  selection: SetupSelection;
  onChange: (selection: SetupSelection) => void;
};

/** A value the options don't hold reads as unset, so MUI never warns about an out-of-range value. */
function knownValue(value: number | null, options: readonly { id: number }[]): number | '' {
  return value !== null && options.some((option) => option.id === value) ? value : '';
}

/**
 * "Set up wrong"'s setup fields: Layout, Size, Holds and, on a board that
 * doesn't tilt, Angle (docs/product/directory-reports.md, "Suggested setup").
 *
 * The state and the reset rules are `@boardsesh/board-config`'s
 * `setupSelection`, shared with the app: a new layout picks its default size
 * and every set of it, a new size picks every set of it, and a set toggles on
 * its own. The options come from the bundled catalogue, so nothing is fetched.
 * Holds never goes to zero: the last checked set can't be unchecked.
 */
export default function SetupSuggestionFields({ selection, onChange }: SetupSuggestionFieldsProps) {
  const { t } = useTranslation('boards');
  const wideAnglesEnabled = useFeatureFlag(MOONBOARD_WIDE_ANGLES_FLAG) === true;
  const fieldId = useId();
  const options = useMemo(
    () => setupSelectionOptions(selection, { wideAnglesEnabled }),
    [selection, wideAnglesEnabled],
  );
  // A board whose angle the options don't list (a MoonBoard at a wide angle
  // with the wide angles off) still shows the angle it has.
  const angles = useMemo(
    () =>
      options.angles.includes(selection.angle)
        ? options.angles
        : [...options.angles, selection.angle].sort((first, second) => first - second),
    [options.angles, selection.angle],
  );
  const dispatch = (action: SetupSelectionAction) => onChange(setupSelectionReducer(selection, action));
  // What the Holds field shows checked. The selection only ever holds sets the
  // catalogue lists for its layout and size (`initialSetupSelection` drops any
  // other, and every transition picks from the catalogue), so this is the
  // selection itself, and a tap's diff below runs against exactly these ids.
  const shownSetIds = selection.setIds;
  const onlySetId = shownSetIds.length === 1 ? shownSetIds[0] : null;

  const handleSetsChange = (event: SelectChangeEvent<number[]>) => {
    const next = event.target.value;
    if (typeof next === 'string') return;
    // One tap toggles one set: whichever id is in one list and not the other.
    const toggled =
      next.find((setId) => !shownSetIds.includes(setId)) ?? shownSetIds.find((setId) => !next.includes(setId));
    if (toggled === undefined || next.length === 0) return;
    dispatch({ type: 'toggleSet', setId: toggled });
  };

  return (
    <Box
      component="fieldset"
      sx={{ border: 0, m: 0, p: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <Typography component="legend" sx={{ mb: 1, p: 0 }}>
        {t('report.web.setup.question')}
      </Typography>

      <FormControl fullWidth>
        <InputLabel id={`${fieldId}-layout`}>{t('report.web.setup.layout')}</InputLabel>
        <Select
          labelId={`${fieldId}-layout`}
          label={t('report.web.setup.layout')}
          value={knownValue(selection.layoutId, options.layouts)}
          onChange={(event: SelectChangeEvent<number | ''>) => {
            if (event.target.value !== '') dispatch({ type: 'selectLayout', layoutId: Number(event.target.value) });
          }}
        >
          {options.layouts.map((layout) => (
            <MenuItem key={layout.id} value={layout.id}>
              {setupLayoutLabel(selection.boardName, layout)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl fullWidth disabled={options.sizes.length === 0}>
        <InputLabel id={`${fieldId}-size`}>{t('report.web.setup.size')}</InputLabel>
        <Select
          labelId={`${fieldId}-size`}
          label={t('report.web.setup.size')}
          value={knownValue(selection.sizeId, options.sizes)}
          onChange={(event: SelectChangeEvent<number | ''>) => {
            if (event.target.value !== '') dispatch({ type: 'selectSize', sizeId: Number(event.target.value) });
          }}
        >
          {options.sizes.map((size) => (
            <MenuItem key={size.id} value={size.id}>
              {setupSizeLabel(size)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl fullWidth disabled={options.sets.length === 0}>
        <InputLabel id={`${fieldId}-holds`}>{t('report.web.setup.holds')}</InputLabel>
        <Select<number[]>
          labelId={`${fieldId}-holds`}
          label={t('report.web.setup.holds')}
          multiple
          value={shownSetIds}
          onChange={handleSetsChange}
          renderValue={(selected) =>
            options.sets
              .filter((set) => selected.includes(set.id))
              .map((set) => set.name)
              .join(', ')
          }
        >
          {options.sets.map((set) => {
            const checked = shownSetIds.includes(set.id);
            return (
              <MenuItem key={set.id} value={set.id} disabled={checked && onlySetId === set.id}>
                <Checkbox checked={checked} tabIndex={-1} disableRipple sx={{ p: 0, mr: 1.5 }} />
                <ListItemText primary={set.name} />
              </MenuItem>
            );
          })}
        </Select>
      </FormControl>

      {selection.angleIsFixed && (
        <FormControl fullWidth>
          <InputLabel id={`${fieldId}-angle`}>{t('report.web.setup.angle')}</InputLabel>
          <Select
            labelId={`${fieldId}-angle`}
            label={t('report.web.setup.angle')}
            value={selection.angle}
            onChange={(event: SelectChangeEvent<number>) =>
              dispatch({ type: 'selectAngle', angle: Number(event.target.value) })
            }
          >
            {angles.map((angle) => (
              <MenuItem key={angle} value={angle}>
                {setupAngleLabel(angle)}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
    </Box>
  );
}
