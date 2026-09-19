import type { SxProps, Theme } from '@mui/material/styles';
import { themeTokens } from '@/app/theme/theme-config';

export type FilterChipOptions = {
  /** Is this the facet the page is currently showing? */
  selected?: boolean;
};

/**
 * The board-facet filter chip. One recipe, because there were three.
 *
 * MUI's default outlined chip has no fill and a barely-there border, which on
 * the near-black page ground loses the whole filter row. Both states are spelled
 * out here: a surface fill and one hairline when unselected; the elevated
 * surface plus a violet border, label and ring when selected.
 *
 * The copies this replaces had already drifted in the way that matters. The
 * homepage chip row was a byte-identical copy of the UNSELECTED half only — no
 * selected fill, no ring, and no `aria-current` — so on `/` the chips could not
 * show which board you were looking at, by construction. Sharing the recipe is
 * what makes that impossible to reintroduce.
 *
 * The border is `--control-border`, not `--separator`: an outlined chip's fill
 * is one step off the page ground (1.19:1), so the border is the only thing
 * identifying it as a control. See the token split in `index.css`.
 *
 * A ToggleButton cannot take this wholesale — it has an `aria-pressed` contract
 * rather than `aria-current` — but it can spread the object and add its own
 * semantics, which is what the radius toggle does.
 */
export function filterChipSx({ selected = false }: FilterChipOptions = {}) {
  return {
    borderRadius: 'var(--border-radius-full)',
    height: 44,
    fontWeight: themeTokens.typography.fontWeight.semibold,
    backgroundColor: selected ? 'var(--semantic-surface-elevated)' : 'var(--semantic-surface)',
    borderColor: selected ? 'var(--color-primary)' : 'var(--control-border)',
    color: selected ? 'var(--color-primary)' : 'var(--neutral-900)',
    boxShadow: selected ? '0 0 0 3px var(--semantic-selected)' : 'none',
    '&:hover': {
      backgroundColor: 'var(--semantic-surface-elevated)',
      borderColor: 'var(--color-primary)',
    },
  } satisfies SxProps<Theme>;
}
