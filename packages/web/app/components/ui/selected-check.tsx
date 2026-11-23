import React from 'react';
import CheckRounded from '@mui/icons-material/CheckRounded';
import { SELECTED_CHECK_ATTRIBUTE } from './filter-chip';

/**
 * The leading check on a selected filter chip, toggle or menu item: the
 * non-colour cue that says which one is on, since the tonal container alone is
 * 1.52:1 against the page. Hidden from assistive tech, which already hears the
 * control's own state (`aria-pressed`, `aria-current`, a checkbox's checked
 * state).
 *
 * Inside a `filterChipSx` chip the recipe shows it only while the chip is
 * selected, so it can be rendered unconditionally where the state lives in CSS
 * (a checkbox chip following `input:checked`).
 *
 * `className` is forwarded because MUI clones an icon it is handed (a Chip's
 * `icon`) with its own slot class, `MuiChip-icon`, which carries the icon's
 * spacing; dropping it would butt the check against the label.
 */
export default function SelectedCheck({ className }: { className?: string }) {
  return (
    <CheckRounded
      aria-hidden="true"
      className={className}
      {...{ [SELECTED_CHECK_ATTRIBUTE]: '' }}
      sx={{ fontSize: 18 }}
    />
  );
}
