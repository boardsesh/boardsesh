import { describe, expect, it, vi } from 'vitest';

// `activate` is Android-only on purpose: on iOS UIAccessibility already routes a
// double-tap to onAccessibilityTap, and an unlabelled entry would make VoiceOver
// read a developer-facing "activate" on every row.
const platform = vi.hoisted(() => ({ OS: 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const { ACTIVATE_ACCESSIBILITY_ACTIONS, rowAccessibilityActionsWith } = await import('../row-accessibility-actions');

describe('rowAccessibilityActionsWith', () => {
  it('prepends activate to a single nested action', () => {
    expect(rowAccessibilityActionsWith({ name: 'moreActions', label: 'More' })).toEqual([
      { name: 'activate' },
      { name: 'moreActions', label: 'More' },
    ]);
  });

  // A row can own more than one nested button — the board card publishes both its
  // ownership action and its download glyph, neither of which VoiceOver can reach
  // inside the card's `accessible` container.
  it('keeps every nested action, in order', () => {
    expect(
      rowAccessibilityActionsWith(
        { name: 'boardAction', label: 'Edit Marco garage' },
        { name: 'download', label: 'Make Marco garage available offline' },
      ).map((entry) => entry.name),
    ).toEqual(['activate', 'boardAction', 'download']);
  });

  it('returns just activate when a caller passes none', () => {
    expect(rowAccessibilityActionsWith()).toEqual([{ name: 'activate' }]);
  });

  it('exposes the shared activate-only list for rows with no nested button', () => {
    expect(ACTIVATE_ACCESSIBILITY_ACTIONS).toEqual([{ name: 'activate' }]);
  });
});
