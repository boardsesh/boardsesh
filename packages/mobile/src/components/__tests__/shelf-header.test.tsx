// @vitest-environment jsdom
// ShelfHeader, ShelfSection and the TextAction they share: the type each part is
// set in, the spacing a shelf owns, and an action that gets its 44pt target from
// its own padded box (handed back by a negative margin) instead of a 44pt row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
    View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
      createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  };
});
vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    tone,
    emphasized,
    color,
    accessibilityRole,
    style,
  }: {
    children?: ReactNode;
    variant?: string;
    tone?: string;
    emphasized?: boolean;
    color?: string;
    accessibilityRole?: string;
    style?: unknown;
  }) =>
    createElement(
      'span',
      {
        'data-style': JSON.stringify(style ?? {}),
        'data-variant': variant,
        'data-tone': tone ?? 'primary',
        'data-emphasized': String(emphasized ?? false),
        'data-color': color ?? 'none',
        role: accessibilityRole === 'header' ? 'heading' : undefined,
      },
      children,
    ),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    hitSlop,
    feedback,
    style,
    testID,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    hitSlop?: unknown;
    feedback?: string;
    style?: unknown;
    testID?: string;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'data-hitslop': JSON.stringify(hitSlop ?? null),
        'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
        'data-feedback': feedback,
        'data-testid': testID,
      },
      children,
    ),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, systemColors: { accent: '#ACCENT' } }),
}));

import { SHELF_HEADER_CONTENT_GAP, SHELF_SECTION_GAP, ShelfHeader, ShelfSection } from '../ShelfHeader';
import { TEXT_ACTION_MIN_TARGET, TextAction } from '../TextAction';
import { textStylesByVariant, type TextVariant } from '../../theme/typography';

function styleOf(element: Element | null): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  ctrl.variant = 'liquidGlass';
});
afterEach(cleanup);

describe('ShelfHeader', () => {
  it('sets the title in title 3 at its emphasized weight, as a heading', () => {
    render(<ShelfHeader title="Your boards" />);
    const title = screen.getByRole('heading', { name: 'Your boards' });
    expect(title.getAttribute('data-variant')).toBe('title3');
    expect(title.getAttribute('data-emphasized')).toBe('true');
  });

  it('owns the 16pt gutter and no height of its own', () => {
    render(<ShelfHeader title="Your boards" testID="shelf" />);
    const header = styleOf(screen.getByTestId('shelf'));
    expect(header.paddingHorizontal).toBe(16);
    expect(header.minHeight).toBeUndefined();
    expect(header.paddingTop).toBeUndefined();
    expect(header.paddingBottom).toBeUndefined();
  });

  it('puts the caption under the title in secondary subheadline', () => {
    render(<ShelfHeader title="Near you" caption="Boards within 5 km" />);
    const caption = screen.getByText('Boards within 5 km');
    expect(caption.getAttribute('data-variant')).toBe('subheadline');
    expect(caption.getAttribute('data-tone')).toBe('secondary');
  });

  it('draws See all in the accent with a chevron, and runs it on tap', () => {
    const onPress = vi.fn();
    render(
      <ShelfHeader
        title="Your boards"
        action={{ label: 'See all', onPress, accessibilityLabel: 'See all your boards' }}
      />,
    );
    const action = screen.getByRole('button', { name: 'See all your boards' });
    expect(screen.getByText('See all').getAttribute('data-color')).toBe('#ACCENT');
    expect(action.querySelector('[data-icon="chevron.right"]')).not.toBeNull();
    fireEvent.click(action);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('lets the action drop under the title rather than squeeze it at large text sizes', () => {
    render(<ShelfHeader title="Your boards" action={{ label: 'See all', onPress: vi.fn() }} />);
    const title = screen.getByRole('heading', { name: 'Your boards' });
    const titleRow = styleOf(title.parentElement);
    expect(titleRow.flexDirection).toBe('row');
    expect(titleRow.flexWrap).toBe('wrap');
    expect(titleRow.rowGap).toBeGreaterThan(0);
    // A zero basis clamped to a minimum share: the line breaks only when the
    // action would leave the title less than that share of the row.
    const titleStyle = styleOf(title);
    expect(titleStyle.flexBasis).toBe(0);
    expect(titleStyle.flexGrow).toBe(1);
    expect(titleStyle.minWidth).toBe('70%');
  });

  it('renders a trailing node after the action', () => {
    render(<ShelfHeader title="Your boards" trailing={<b data-testid="menu" />} />);
    expect(screen.getByTestId('menu')).toBeTruthy();
  });
});

describe('ShelfSection', () => {
  it('puts 8pt between the header and its content and 28pt before the next shelf', () => {
    render(
      <ShelfSection title="Your boards" testID="section">
        <p>content</p>
      </ShelfSection>,
    );
    expect(SHELF_HEADER_CONTENT_GAP).toBe(8);
    expect(SHELF_SECTION_GAP).toBe(28);
    const section = screen.getByTestId('section');
    expect(styleOf(section).paddingBottom).toBe(28);
    const content = screen.getByText('content').parentElement;
    expect(styleOf(content).paddingTop).toBe(8);
  });
});

describe('TextAction', () => {
  it.each([
    ['liquidGlass', 44],
    ['material', 48],
  ] as const)(
    'reaches the %s minimum target (%ipt) with its own padded box, and takes no room in the row',
    (variant, target) => {
      ctrl.variant = variant;
      expect(TEXT_ACTION_MIN_TARGET[variant]).toBe(target);
      render(<TextAction label="Retry" onPress={vi.fn()} />);
      const action = screen.getByRole('button', { name: 'Retry' });
      // Not hitSlop: on Fabric a parent hit-tests children only inside its own
      // bounds unless their layout overflows it, so slop past a one-line row is dead.
      expect(JSON.parse(action.getAttribute('data-hitslop') ?? 'null')).toBeNull();
      const box = JSON.parse(action.getAttribute('data-style') ?? '{}') as Record<string, number>;
      const textVariant = screen.getByText('Retry').getAttribute('data-variant') as TextVariant;
      const lineHeight = textStylesByVariant[variant][textVariant].lineHeight;
      expect(lineHeight + 2 * box.paddingVertical).toBeGreaterThanOrEqual(target);
      // The same room handed back, so the label doesn't move and the row doesn't grow.
      expect(box.marginVertical).toBe(-box.paddingVertical);
      expect(box.marginHorizontal).toBe(-box.paddingHorizontal);
      expect(box.paddingHorizontal).toBeGreaterThan(0);
      expect(action.getAttribute('data-feedback')).toBe('opacity');
    },
  );

  it('has no chevron unless asked', () => {
    render(<TextAction label="Retry" onPress={vi.fn()} />);
    expect(screen.getByRole('button').querySelector('[data-icon]')).toBeNull();
  });

  it('uses subheadline semibold on Liquid Glass and the M3 label type on Material', () => {
    render(<TextAction label="Retry" onPress={vi.fn()} />);
    expect(screen.getByText('Retry').getAttribute('data-variant')).toBe('subheadline');
    expect(screen.getByText('Retry').getAttribute('data-emphasized')).toBe('true');
    cleanup();
    ctrl.variant = 'material';
    render(<TextAction label="Retry" onPress={vi.fn()} />);
    expect(screen.getByText('Retry').getAttribute('data-variant')).toBe('label');
    expect(screen.getByText('Retry').getAttribute('data-emphasized')).toBe('false');
  });
});
