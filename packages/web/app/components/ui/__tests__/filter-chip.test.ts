import { describe, it, expect } from 'vite-plus/test';
import { filterChipSx, SELECTED_CHECK_ATTRIBUTE } from '../filter-chip';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * The chip row shipped in three places and the copies had drifted in the way
 * that matters: the homepage row was the UNSELECTED half only, so it had no
 * selected fill, edge or label colour at all.
 *
 * What is worth pinning is therefore that the two states are actually
 * DISTINGUISHABLE — a selected chip that looks like an unselected one is the bug
 * — that selection has a non-colour cue (the check), and that the resting edge
 * reads the control token, since a transparent chip's border is its only
 * affordance.
 */
describe('filterChipSx', () => {
  const unselected = filterChipSx();
  const selected = filterChipSx({ selected: true });
  const checkSelector = `& [${SELECTED_CHECK_ATTRIBUTE}]` as const;

  it('defaults to unselected', () => {
    expect(filterChipSx()).toEqual(filterChipSx({ selected: false }));
  });

  it('changes ground, edge and label when selected, not just one of them', () => {
    expect(selected.backgroundColor).not.toBe(unselected.backgroundColor);
    expect(selected.borderColor).not.toBe(unselected.borderColor);
    expect(selected.color).not.toBe(unselected.color);
  });

  it('rests as a grey control: transparent, label ink, --control-border, never --separator', () => {
    // WCAG 1.4.11: the chip has no fill of its own, so the border carries the whole
    // affordance; --separator composites to ~1.4:1 and would fail.
    expect(unselected.backgroundColor).toBe('transparent');
    expect(unselected.color).toBe('var(--neutral-900)');
    expect(unselected.borderColor).toBe('var(--control-border)');
    expect(unselected.fontWeight).toBe(500);
    expect(JSON.stringify(unselected)).not.toContain('--separator');
    expect(JSON.stringify(unselected)).not.toContain('--color-primary');
  });

  it('marks the selected chip with the tonal container and its ink, never the foreground violet', () => {
    // #9784FF on #34276B is 4.28:1, under AA; the container's own ink is 9.89:1.
    expect(selected.backgroundColor).toBe('var(--semantic-selected)');
    expect(selected.color).toBe('var(--semantic-on-selected)');
    expect(JSON.stringify(selected)).not.toContain('--color-primary');
  });

  it('draws no ring or halo in either state', () => {
    expect(selected).not.toHaveProperty('boxShadow');
    expect(unselected).not.toHaveProperty('boxShadow');
  });

  it('shows the check only when selected, as the non-colour cue', () => {
    // The tonal container is 1.52:1 against the page, so colour alone cannot say
    // which chip is on.
    expect(selected[checkSelector]).toMatchObject({ display: 'inline-flex' });
    expect(unselected[checkSelector]).toMatchObject({ display: 'none' });
  });

  it("keeps each state's ground on hover and keyboard focus, over MUI's clickable-chip washes", () => {
    expect(unselected['&:hover, &.MuiChip-clickable:hover']).toMatchObject({
      backgroundColor: 'var(--semantic-hover)',
    });
    expect(selected['&:hover, &.MuiChip-clickable:hover']).toMatchObject({
      backgroundColor: 'var(--semantic-selected-hover)',
    });
    expect(selected['&.Mui-focusVisible']).toEqual({ backgroundColor: 'var(--semantic-selected)' });
  });

  it('keeps both states on the 44px target as full pills, unlike 10px buttons', () => {
    for (const recipe of [unselected, selected]) {
      expect(recipe.minHeight).toBe(44);
      expect(recipe.borderRadius).toBe(`${themeTokens.borderRadius.full}px`);
      expect(recipe.borderRadius).not.toBe(`${themeTokens.borderRadius.button}px`);
    }
  });
});
