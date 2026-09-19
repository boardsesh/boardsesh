import { describe, it, expect } from 'vite-plus/test';
import { filterChipSx } from '../filter-chip';

/**
 * The chip row shipped in three places and the copies had drifted in the way
 * that matters: the homepage row was the UNSELECTED half only, so it had no
 * selected fill, border, label colour or ring at all.
 *
 * What is worth pinning is therefore that the two states are actually
 * DISTINGUISHABLE — a selected chip that looks like an unselected one is the bug
 * — and that the border reads the control token, since an outlined chip's fill
 * is one step off the page ground and the border is the only affordance.
 */
describe('filterChipSx', () => {
  const unselected = filterChipSx();
  const selected = filterChipSx({ selected: true });

  it('defaults to unselected', () => {
    expect(filterChipSx()).toEqual(filterChipSx({ selected: false }));
  });

  it('changes every state-bearing property when selected, not just one', () => {
    // One-property selection (a border alone, say) is what makes a filter row
    // hard to read at a glance. Fill, edge, label and ring all move together.
    expect(selected.backgroundColor).not.toBe(unselected.backgroundColor);
    expect(selected.borderColor).not.toBe(unselected.borderColor);
    expect(selected.color).not.toBe(unselected.color);
    expect(selected.boxShadow).not.toBe(unselected.boxShadow);
  });

  it('marks the selected chip with the brand violet and a ring', () => {
    expect(selected.borderColor).toBe('var(--color-primary)');
    expect(selected.color).toBe('var(--color-primary)');
    expect(selected.boxShadow).toBe('0 0 0 3px var(--semantic-selected)');
    expect(unselected.boxShadow).toBe('none');
  });

  it('draws the unselected edge with --control-border, never --separator', () => {
    // WCAG 1.4.11: the chip fill is --semantic-surface on --semantic-background,
    // which is 1.19:1, so the border carries the whole affordance.
    expect(unselected.borderColor).toBe('var(--control-border)');
    expect(JSON.stringify(unselected)).not.toContain('--separator');
  });

  it('keeps both states on the 44px target and the full pill radius', () => {
    for (const recipe of [unselected, selected]) {
      expect(recipe.height).toBe(44);
      expect(recipe.borderRadius).toBe('var(--border-radius-full)');
    }
  });
});
