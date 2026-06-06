// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import { getSoftGradeColor } from '@boardsesh/play-view';
import { spacing } from '../../../theme/tokens';
import { DrawerHeader, resolveDrawerHeaderTrailingWidth } from '../../DrawerHeader';
import { estimateInitialGradeColumnWidth, resolvePlayDrawerHeaderGradeColor } from '../PlayDrawerHeader';

type MockLayoutEvent = {
  nativeEvent: {
    layout: {
      width: number;
    };
  };
};

type MockViewProps = {
  children?: ReactNode;
  onLayout?: (event: MockLayoutEvent) => void;
  style?: unknown;
};

const viewMockState = vi.hoisted(() => ({
  views: [] as Array<Pick<MockViewProps, 'onLayout' | 'style'>>,
}));

vi.mock('react-native', () => ({
  View: ({ children, onLayout, style }: MockViewProps) => {
    viewMockState.views.push({ onLayout, style });
    const styleList = Array.isArray(style) ? style : [style];
    const flattenedStyle = Object.assign({}, ...styleList.filter(Boolean)) as {
      minWidth?: number;
      width?: number;
    };

    return createElement(
      'div',
      {
        'data-min-width': flattenedStyle.minWidth == null ? undefined : String(flattenedStyle.minWidth),
        'data-width': flattenedStyle.width == null ? undefined : String(flattenedStyle.width),
      },
      children,
    );
  },
  Appearance: {
    setColorScheme: vi.fn(),
  },
  useColorScheme: () => 'light',
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

vi.mock('../../ClimbAttributeIcons', () => ({
  ClimbAttributeIcons: () => null,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light' }),
}));

beforeEach(() => {
  viewMockState.views = [];
});

function getLatestTrailingLayoutHandler(): (event: MockLayoutEvent) => void {
  const trailingView = [...viewMockState.views].reverse().find((view) => view.onLayout);
  const layoutHandler = trailingView?.onLayout;
  expect(layoutHandler).toBeTypeOf('function');
  if (!layoutHandler) {
    throw new Error('Expected DrawerHeader trailing View to expose an onLayout handler');
  }
  return layoutHandler;
}

function getNumericAttribute(container: HTMLElement, selector: string, attribute: string): number {
  const element = container.querySelector(selector);
  expect(element).not.toBeNull();
  const rawValue = element?.getAttribute(attribute);
  expect(rawValue).not.toBeNull();
  return Number(rawValue);
}

function getLeadingSpacerWidth(container: HTMLElement): number {
  return getNumericAttribute(container, '[data-width]', 'data-width');
}

function getTrailingSlotMinWidth(container: HTMLElement): number {
  return getNumericAttribute(container, '[data-min-width]:not([data-min-width="0"])', 'data-min-width');
}

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

describe('DrawerHeader layout measurement', () => {
  it('lets the mirrored spacer shrink after a wider trailing measurement', () => {
    const { container, rerender } = render(
      createElement(DrawerHeader, {
        center: 'Moon Dance',
        trailing: 'V16',
        trailingMinWidth: spacing[12],
      }),
    );

    expect(getLeadingSpacerWidth(container)).toBe(spacing[12]);
    expect(getTrailingSlotMinWidth(container)).toBe(spacing[12]);

    act(() => {
      getLatestTrailingLayoutHandler()({ nativeEvent: { layout: { width: spacing[16] } } });
    });

    expect(getLeadingSpacerWidth(container)).toBe(spacing[16]);
    expect(getTrailingSlotMinWidth(container)).toBe(spacing[12]);

    viewMockState.views = [];
    rerender(
      createElement(DrawerHeader, {
        center: 'Moon Dance',
        trailing: 'V3',
        trailingMinWidth: spacing[12],
      }),
    );

    act(() => {
      getLatestTrailingLayoutHandler()({ nativeEvent: { layout: { width: spacing[12] } } });
    });

    expect(getLeadingSpacerWidth(container)).toBe(spacing[12]);
    expect(getTrailingSlotMinWidth(container)).toBe(spacing[12]);
  });

  it('ignores stale measured width when the minimum width changes', () => {
    const { container, rerender } = render(
      createElement(DrawerHeader, {
        center: 'Moon Dance',
        trailing: '8B+/V14',
        trailingMinWidth: spacing[16],
      }),
    );

    act(() => {
      getLatestTrailingLayoutHandler()({ nativeEvent: { layout: { width: spacing[16] + spacing[4] } } });
    });

    expect(getLeadingSpacerWidth(container)).toBe(spacing[16] + spacing[4]);

    viewMockState.views = [];
    rerender(
      createElement(DrawerHeader, {
        center: 'Moon Dance',
        trailing: 'V3',
        trailingMinWidth: spacing[12],
      }),
    );

    expect(getLeadingSpacerWidth(container)).toBe(spacing[12]);
    expect(getTrailingSlotMinWidth(container)).toBe(spacing[12]);
  });
});

describe('estimateInitialGradeColumnWidth', () => {
  it('uses the minimum width for compact grade labels', () => {
    expect(estimateInitialGradeColumnWidth('V3')).toBe(spacing[12]);
  });

  it('reserves wider columns for long grade labels before layout fires', () => {
    expect(estimateInitialGradeColumnWidth('6c+/V5')).toBeGreaterThan(spacing[12]);
  });
});

describe('resolvePlayDrawerHeaderGradeColor', () => {
  it('uses raw difficulty when the displayed grade is user-formatted', () => {
    expect(resolvePlayDrawerHeaderGradeColor('V5', '6c+/V5')).toBe(getSoftGradeColor('6c+/V5'));
  });

  it('uses the dark-mode softened grade color when requested', () => {
    expect(resolvePlayDrawerHeaderGradeColor('V5', '6c+/V5', true)).toBe(getSoftGradeColor('6c+/V5', true));
  });

  it('falls back to the default grade color when no grade color matches', () => {
    expect(resolvePlayDrawerHeaderGradeColor('Project')).toBe(DEFAULT_GRADE_COLOR);
  });
});
