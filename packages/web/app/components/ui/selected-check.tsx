import React from 'react';
import CheckRounded from '@mui/icons-material/CheckRounded';
import { SELECTED_CHECK_ATTRIBUTE } from './filter-chip';

/**
 * The leading check on a selected filter chip or toggle: the non-colour cue that
 * says which one is on, since the tonal container alone is 1.52:1 against the
 * page. Hidden from assistive tech, which already hears the control's own
 * pressed or checked state.
 *
 * Inside a `filterChipSx` chip the recipe shows it only while the chip is
 * selected, so it can be rendered unconditionally where the state lives in CSS
 * (a checkbox chip following `input:checked`).
 */
export default function SelectedCheck() {
  return <CheckRounded aria-hidden="true" {...{ [SELECTED_CHECK_ATTRIBUTE]: '' }} sx={{ fontSize: 18 }} />;
}
