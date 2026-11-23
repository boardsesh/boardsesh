import type { SxProps, Theme } from '@mui/material/styles';
import { themeTokens } from '@/app/theme/theme-config';

export type FilterChipOptions = {
  /** Is this the facet the page is currently showing? */
  selected?: boolean;
};

/**
 * The attribute `SelectedCheck` (`selected-check.tsx`) carries, so the recipe can
 * show the check on a selected chip and hide it on a resting one. A selector
 * rather than a prop because the checkbox chips change state with no React
 * render: the label follows its own `input:checked`, and the check has to follow
 * it in CSS too.
 */
export const SELECTED_CHECK_ATTRIBUTE = 'data-selected-check';
const SELECTED_CHECK_SELECTOR = `& [${SELECTED_CHECK_ATTRIBUTE}]` as const;

/**
 * The board-facet filter chip. One recipe, because there were three.
 *
 * A full pill: on www buttons are 10px rounded rectangles and chips keep the round
 * end, which is what marks a tag or filter rather than an action (#8041). A 44px
 * target, and two states spelled out.
 *
 * - **Rest**: transparent, one `--control-border` edge, the label ink
 *   (`--neutral-900`) at weight 500. The chip's fill is the page, so the border is
 *   the only thing identifying it as a control (WCAG 1.4.11, 3.93:1 or more on
 *   every surface step); `--separator` would fail that.
 * - **Selected**: the opaque tonal container (`--semantic-selected`) with its own
 *   ink (`--semantic-on-selected`, 9.89:1), and a leading check. No ring, no
 *   violet edge: the container's edge is 1.52:1 on the page, so the check is the
 *   non-colour cue that says which chip is on. Render `SelectedCheck` inside the
 *   chip; this recipe shows it only when selected.
 *
 * The selection itself is announced by the caller's control (`aria-pressed` on
 * the board-type links, the checkbox's own checked state on the narrower tiers);
 * the check is `aria-hidden`.
 *
 * Hover and keyboard focus keep the state's ground: MUI's outlined clickable
 * chip paints `action.hover` / `action.focus` over the fill at `.MuiChip-clickable`
 * specificity, which would wash the tonal container out, so both selectors are
 * restated here.
 *
 * The copies this replaces had already drifted in the way that matters. The
 * homepage chip row was a byte-identical copy of the UNSELECTED half only — no
 * selected fill and no `aria-current` — so on `/` the chips could not show which
 * board you were looking at, by construction. Sharing the recipe is what makes
 * that impossible to reintroduce.
 */
export function filterChipSx({ selected = false }: FilterChipOptions = {}) {
  const ground = selected ? 'var(--semantic-selected)' : 'transparent';
  const edge = selected ? 'var(--semantic-selected)' : 'var(--control-border)';
  const hoverGround = selected ? 'var(--semantic-selected-hover)' : 'var(--semantic-hover)';
  return {
    borderRadius: `${themeTokens.borderRadius.full}px`,
    height: 'auto',
    minHeight: 44,
    fontWeight: themeTokens.typography.fontWeight.medium,
    backgroundColor: ground,
    borderColor: edge,
    color: selected ? 'var(--semantic-on-selected)' : 'var(--neutral-900)',
    [SELECTED_CHECK_SELECTOR]: {
      display: selected ? 'inline-flex' : 'none',
      color: 'inherit',
    },
    '&:hover, &.MuiChip-clickable:hover': {
      backgroundColor: hoverGround,
      borderColor: edge,
    },
    '&.Mui-focusVisible': {
      backgroundColor: ground,
    },
  } satisfies SxProps<Theme>;
}
