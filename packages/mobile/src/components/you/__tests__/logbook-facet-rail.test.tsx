// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LOGBOOK_FILTERS } from '@boardsesh/logbook';
import type { GradeBound } from '@boardsesh/climb-filters';

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: 'opaque-scene-background' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));
vi.mock('../../grade', () => ({
  GradeRangeRail: ({ onChange }: { onChange: (bound: GradeBound) => void }) =>
    createElement('button', { onClick: () => onChange({ minGradeId: 10, maxGradeId: 12 }) }, 'Grade range'),
}));
vi.mock('../../filter-sheet/AngleRangeRail', () => ({
  AngleRangeRail: ({ onChange }: { onChange: (range: [number, number]) => void }) =>
    createElement('button', { onClick: () => onChange([35, 45]) }, 'Angle range'),
}));

// Explicit path bypasses the global null rail alias used by tab-level suites.
const { LogbookFacetRail } = await vi.importActual<typeof import('../LogbookFacetRail')>('../LogbookFacetRail.tsx');

describe('LogbookFacetRail', () => {
  it('backs only the open rail and keeps grade and angle selections live', () => {
    const onUpdateFilters = vi.fn();
    const props = { filters: DEFAULT_LOGBOOK_FILTERS, grades: [], onUpdateFilters };
    const { queryByTestId, getByTestId, getByRole, rerender } = render(<LogbookFacetRail {...props} openRail={null} />);
    expect(queryByTestId('logbook-facet-rail')).toBeNull();

    for (const [openRail, label, expectedPatch] of [
      ['grade', 'Grade range', { minGrade: 10, maxGrade: 12 }],
      ['angle', 'Angle range', { angleRange: [35, 45] }],
    ] as const) {
      rerender(<LogbookFacetRail {...props} openRail={openRail} />);
      expect(JSON.parse(getByTestId('logbook-facet-rail').getAttribute('data-style') ?? '{}')).toMatchObject({
        backgroundColor: 'opaque-scene-background',
      });
      fireEvent.click(getByRole('button', { name: label }));
      expect(onUpdateFilters).toHaveBeenLastCalledWith(expectedPatch);
    }

    rerender(<LogbookFacetRail {...props} openRail={null} />);
    expect(queryByTestId('logbook-facet-rail')).toBeNull();
  });
});
