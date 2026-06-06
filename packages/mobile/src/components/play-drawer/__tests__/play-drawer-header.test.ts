import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GRADE_COLOR, getGradeColor } from '@boardsesh/board-constants/grade-colors';
import { spacing } from '../../../theme/tokens';
import { resolveDrawerHeaderTrailingWidth } from '../../DrawerHeader';
import { getInitialGradeColumnWidth, resolvePlayDrawerHeaderGradeColor } from '../PlayDrawerHeader';

vi.mock('react-native', () => ({
  View: 'View',
  PlatformColor: (colorName: string): string => colorName,
  Platform: {
    OS: 'ios',
  },
  StyleSheet: {
    create: <Styles extends Record<string, unknown>>(styles: Styles): Styles => styles,
  },
}));

vi.mock('../../Text', () => ({
  Text: 'Text',
}));

describe('resolveDrawerHeaderTrailingWidth', () => {
  it('clamps measured widths to the minimum grade column width', () => {
    expect(resolveDrawerHeaderTrailingWidth(spacing[4], spacing[12])).toBe(spacing[12]);
  });

  it('rounds measured widths up before storing them', () => {
    expect(resolveDrawerHeaderTrailingWidth(spacing[12] + 0.25, spacing[12])).toBe(spacing[12] + 1);
  });

  it('keeps measured widths wider than the minimum', () => {
    expect(resolveDrawerHeaderTrailingWidth(spacing[16], spacing[12])).toBe(spacing[16]);
  });
});

describe('getInitialGradeColumnWidth', () => {
  it('uses the minimum width for compact grade labels', () => {
    expect(getInitialGradeColumnWidth('V3')).toBe(spacing[12]);
  });

  it('reserves wider columns for long grade labels before layout fires', () => {
    expect(getInitialGradeColumnWidth('6c+/V5')).toBeGreaterThan(spacing[12]);
  });
});

describe('resolvePlayDrawerHeaderGradeColor', () => {
  it('uses raw difficulty when the displayed grade is user-formatted', () => {
    expect(resolvePlayDrawerHeaderGradeColor('V5', '6c+/V5')).toBe(getGradeColor('6c+/V5'));
  });

  it('falls back to the default grade color when no grade color matches', () => {
    expect(resolvePlayDrawerHeaderGradeColor('Project')).toBe(DEFAULT_GRADE_COLOR);
  });
});
