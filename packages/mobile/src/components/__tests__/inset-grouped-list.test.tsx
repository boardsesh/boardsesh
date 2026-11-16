// @vitest-environment jsdom
// InsetGroupedList and ArtRow: separators only between rows, inset to the text;
// rows that own the gutter; and a selected row that reads as a state, not a link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
    View: ({
      children,
      style,
      testID,
      accessibilityState,
      accessibilityElementsHidden,
    }: {
      children?: ReactNode;
      style?: unknown;
      testID?: string;
      accessibilityState?: unknown;
      accessibilityElementsHidden?: boolean;
    }) =>
      createElement(
        'div',
        {
          'data-testid': testID,
          'data-style': JSON.stringify(flattenStyle(style)),
          'data-state': accessibilityState ? JSON.stringify(accessibilityState) : undefined,
          'aria-hidden': accessibilityElementsHidden ? 'true' : undefined,
        },
        children,
      ),
  };
});
vi.mock('../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../Text', () => ({
  Text: ({
    children,
    variant,
    tone,
    emphasized,
    color,
  }: {
    children?: ReactNode;
    variant?: string;
    tone?: string;
    emphasized?: boolean;
    color?: string;
  }) =>
    createElement(
      'span',
      {
        'data-variant': variant,
        'data-tone': tone ?? 'primary',
        'data-emphasized': String(emphasized ?? false),
        'data-color': color ?? 'none',
      },
      children,
    ),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../PressableSurface', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    PressableSurface: ({
      children,
      onPress,
      onLongPress,
      accessibilityLabel,
      accessibilityState,
      feedback,
      style,
      testID,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
      accessibilityLabel?: string;
      accessibilityState?: unknown;
      feedback?: string;
      style?: unknown;
      testID?: string;
    }) =>
      createElement(
        'button',
        {
          onClick: onPress,
          onContextMenu: onLongPress,
          'aria-label': accessibilityLabel,
          'data-state': accessibilityState ? JSON.stringify(accessibilityState) : undefined,
          'data-feedback': feedback,
          'data-style': JSON.stringify(flattenStyle(style)),
          'data-testid': testID,
        },
        children,
      ),
  };
});
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { separator: '#SEPARATOR', label: '#LABEL', tertiaryLabel: '#TERTIARY' },
    selection: { text: '#SELECTION_TEXT', checkmark: '#CHECKMARK', fill: '#SELECTION_FILL' },
  }),
}));

import { InsetGroupedList, insetGroupedRowStyles } from '../InsetGroupedList';
import { ArtRow } from '../ArtRow';

function styleOf(element: Element | null): Record<string, unknown> {
  return JSON.parse(element?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;
}

function separators(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('[data-style]')).filter(
    (element) => styleOf(element).backgroundColor === '#SEPARATOR',
  );
}

afterEach(cleanup);

describe('InsetGroupedList', () => {
  it('draws a hairline between rows, never above the first or below the last', () => {
    const { container } = render(
      <InsetGroupedList>
        <p>one</p>
        {null}
        <p>two</p>
        {false}
        <p>three</p>
      </InsetGroupedList>,
    );
    expect(separators(container)).toHaveLength(2);
  });

  it('insets separators to the text after the art slot, or to the gutter', () => {
    const { container } = render(
      <InsetGroupedList>
        <p>one</p>
        <p>two</p>
      </InsetGroupedList>,
    );
    // 16pt gutter + 44pt slot + 12pt gap.
    expect(styleOf(separators(container)[0]).marginStart).toBe(72);
    cleanup();
    const compact = render(
      <InsetGroupedList separatorInset="compact">
        <p>one</p>
        <p>two</p>
      </InsetGroupedList>,
    );
    expect(styleOf(separators(compact.container)[0]).marginStart).toBe(64);
    cleanup();
    const gutter = render(
      <InsetGroupedList separatorInset="gutter">
        <p>one</p>
        <p>two</p>
      </InsetGroupedList>,
    );
    expect(styleOf(separators(gutter.container)[0]).marginStart).toBe(16);
  });

  it('lets each row take back the card padding, clipped to its corners', () => {
    render(
      <InsetGroupedList testID="rows">
        <p>one</p>
      </InsetGroupedList>,
    );
    const rows = styleOf(screen.getByTestId('rows'));
    expect(rows.margin).toBe(-16);
    expect(rows.overflow).toBe('hidden');
    expect(insetGroupedRowStyles.row.paddingHorizontal).toBe(16);
  });
});

describe('ArtRow', () => {
  it('sets the title in headline and a string subtitle in secondary subheadline', () => {
    render(<ArtRow art={null} artSize="regular" title="Garage Board" subtitle="Kilter · 40°" eyebrow="On it" />);
    expect(screen.getByText('Garage Board').getAttribute('data-variant')).toBe('headline');
    const subtitle = screen.getByText('Kilter · 40°');
    expect(subtitle.getAttribute('data-variant')).toBe('subheadline');
    expect(subtitle.getAttribute('data-tone')).toBe('secondary');
    const eyebrow = screen.getByText('On it');
    expect(eyebrow.getAttribute('data-variant')).toBe('footnote');
    expect(eyebrow.getAttribute('data-tone')).toBe('secondary');
  });

  it('holds the art in a slot as wide as its size, hidden from VoiceOver', () => {
    const { rerender } = render(<ArtRow art={<b data-testid="art" />} artSize="regular" title="Board" />);
    const slot = screen.getByTestId('art').parentElement;
    expect(styleOf(slot).width).toBe(44);
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    rerender(<ArtRow art={<b data-testid="art" />} artSize="compact" title="Board" />);
    expect(styleOf(screen.getByTestId('art').parentElement).width).toBe(36);
  });

  it('presses with an opacity dip, never a scale, and passes long press through', () => {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Board"
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityLabel="Board"
      />,
    );
    const row = screen.getByRole('button', { name: 'Board' });
    expect(row.getAttribute('data-feedback')).toBe('opacity');
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    expect(onPress).toHaveBeenCalledOnce();
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('is a static row without a press handler', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" testID="row" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('row').tagName).toBe('DIV');
  });

  it('marks a selected row with the selection fill, label title and an accent checkmark', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        accessory="checkmark"
        selected
        onPress={vi.fn()}
        testID="row"
      />,
    );
    const row = screen.getByTestId('row');
    expect(styleOf(row).backgroundColor).toBe('#SELECTION_FILL');
    expect(JSON.parse(row.getAttribute('data-state') ?? '{}')).toEqual({ selected: true });
    const title = screen.getByText('Garage Board');
    expect(title.getAttribute('data-color')).toBe('#SELECTION_TEXT');
    expect(title.getAttribute('data-emphasized')).toBe('true');
    const checkmark = row.querySelector('[data-icon="check.small"]');
    expect(checkmark?.getAttribute('data-color')).toBe('#CHECKMARK');
    expect(styleOf(checkmark?.parentElement ?? null).opacity).toBeUndefined();
  });

  it('keeps an unselected choice row unfilled, with its checkmark laid out but not drawn', () => {
    render(
      <ArtRow art={null} artSize="regular" title="Club wall" accessory="checkmark" onPress={vi.fn()} testID="row" />,
    );
    const row = screen.getByTestId('row');
    expect(styleOf(row).backgroundColor).toBeUndefined();
    expect(JSON.parse(row.getAttribute('data-state') ?? '{}')).toEqual({ selected: false });
    expect(screen.getByText('Club wall').getAttribute('data-color')).toBe('none');
    const checkmark = row.querySelector('[data-icon="check.small"]');
    expect(styleOf(checkmark?.parentElement ?? null).opacity).toBe(0);
  });

  it('says nothing about selection on a row that is not a choice', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" accessory="chevron" onPress={vi.fn()} testID="row" />);
    expect(screen.getByTestId('row').getAttribute('data-state')).toBeNull();
    expect(screen.getByTestId('row').querySelector('[data-icon="chevron.right"]')).not.toBeNull();
  });

  it('puts the status beside the title and lets the title give way', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Bergen Klatresenter Danmarksplass"
        status={<em data-testid="status">Closest</em>}
      />,
    );
    const title = screen.getByText('Bergen Klatresenter Danmarksplass');
    expect(title.parentElement).toBe(screen.getByTestId('status').parentElement);
    expect(styleOf(title.parentElement).flexDirection).toBe('row');
  });

  it('renders a custom accessory node as given', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" accessory={<u data-testid="menu" />} />);
    expect(screen.getByTestId('menu')).toBeTruthy();
  });
});
