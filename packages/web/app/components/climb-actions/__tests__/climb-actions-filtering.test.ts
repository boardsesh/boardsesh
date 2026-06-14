import { describe, it, expect } from 'vite-plus/test';
import { type ClimbActionType, DEFAULT_ACTION_ORDER } from '../types';

/**
 * Test the filtering logic used in ClimbActions component.
 * Extracted as a pure function to test without needing to render the full component
 * with all its context providers and action dependencies.
 *
 * This mirrors the logic in ClimbActions:
 *   let actions = include || DEFAULT_ACTION_ORDER;
 *   actions = actions.filter((action) => !exclude.includes(action));
 */
function getActionsToShow(include?: ClimbActionType[], exclude: ClimbActionType[] = []): ClimbActionType[] {
  let actions = include || DEFAULT_ACTION_ORDER;
  actions = actions.filter((action) => !exclude.includes(action));
  return actions;
}

describe('ClimbActions filtering logic', () => {
  it('shows all actions in DEFAULT_ACTION_ORDER when no include/exclude provided', () => {
    const result = getActionsToShow();
    expect(result).toEqual(DEFAULT_ACTION_ORDER);
    expect(result).toHaveLength(11);
  });

  it('has the correct DEFAULT_ACTION_ORDER', () => {
    expect(DEFAULT_ACTION_ORDER).toEqual([
      'mirror',
      'setActive',
      'queue',
      'goToQueue',
      'share',
      'favorite',
      'tick',
      'playlist',
      'fork',
      'viewDetails',
      'openInApp',
    ]);
  });

  it('shows only specified actions when include is provided', () => {
    const include: ClimbActionType[] = ['viewDetails', 'fork', 'queue'];
    const result = getActionsToShow(include);
    expect(result).toEqual(['viewDetails', 'fork', 'queue']);
    expect(result).toHaveLength(3);
  });

  it('removes excluded actions when exclude is provided', () => {
    const exclude: ClimbActionType[] = ['mirror', 'openInApp'];
    const result = getActionsToShow(undefined, exclude);
    expect(result).not.toContain('mirror');
    expect(result).not.toContain('openInApp');
    expect(result).toHaveLength(DEFAULT_ACTION_ORDER.length - 2);
  });

  it('handles combined include + exclude (include defines the set, then exclude filters)', () => {
    const include: ClimbActionType[] = ['viewDetails', 'fork', 'favorite', 'queue'];
    const exclude: ClimbActionType[] = ['favorite'];
    const result = getActionsToShow(include, exclude);
    expect(result).toEqual(['viewDetails', 'fork', 'queue']);
    expect(result).not.toContain('favorite');
  });

  it('returns empty array when all included actions are excluded', () => {
    const include: ClimbActionType[] = ['viewDetails', 'fork'];
    const exclude: ClimbActionType[] = ['viewDetails', 'fork'];
    const result = getActionsToShow(include, exclude);
    expect(result).toEqual([]);
  });

  it('preserves order from include when provided', () => {
    const include: ClimbActionType[] = ['queue', 'fork', 'viewDetails'];
    const result = getActionsToShow(include);
    expect(result).toEqual(['queue', 'fork', 'viewDetails']);
  });

  it('preserves order from DEFAULT_ACTION_ORDER when include not provided', () => {
    const exclude: ClimbActionType[] = ['fork'];
    const result = getActionsToShow(undefined, exclude);

    // Check ordering: mirror should still come first
    expect(result[0]).toBe('mirror');
    // And openInApp should still come last
    expect(result[result.length - 1]).toBe('openInApp');
  });

  it('handles excluding actions not in include list gracefully', () => {
    const include: ClimbActionType[] = ['viewDetails', 'fork'];
    const exclude: ClimbActionType[] = ['mirror', 'openInApp']; // These are not in include
    const result = getActionsToShow(include, exclude);
    expect(result).toEqual(['viewDetails', 'fork']);
  });

  it('handles empty exclude array as no-op', () => {
    const result = getActionsToShow(undefined, []);
    expect(result).toEqual(DEFAULT_ACTION_ORDER);
  });

  it('handles single action in include', () => {
    const include: ClimbActionType[] = ['viewDetails'];
    const result = getActionsToShow(include);
    expect(result).toEqual(['viewDetails']);
  });

  it('excludes goToQueue when specified', () => {
    const result = getActionsToShow(undefined, ['goToQueue']);
    expect(result).not.toContain('goToQueue');
    expect(result).toHaveLength(DEFAULT_ACTION_ORDER.length - 1);
  });

  it('includes goToQueue in a custom include list', () => {
    const include: ClimbActionType[] = ['queue', 'goToQueue', 'viewDetails'];
    const result = getActionsToShow(include);
    expect(result).toEqual(['queue', 'goToQueue', 'viewDetails']);
    expect(result).toContain('goToQueue');
  });
});
