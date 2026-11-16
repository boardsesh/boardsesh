// @vitest-environment jsdom
// InsetGroupedList and ArtRow: separators only between rows, inset to the text;
// rows that own the gutter; and a selected row that reads as a state, not a link.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type AccessibilityActionHandler = (event: { nativeEvent: { actionName: string } }) => void;
const ctrl = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  actionHandlers: new Map<string, AccessibilityActionHandler>(),
}));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: {
      get OS() {
        return ctrl.os;
      },
    },
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
      accessibilityActions,
      onAccessibilityAction,
      feedback,
      style,
      testID,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      onLongPress?: () => void;
      accessibilityLabel?: string;
      accessibilityState?: unknown;
      accessibilityActions?: unknown;
      onAccessibilityAction?: AccessibilityActionHandler;
      feedback?: string;
      style?: unknown;
      testID?: string;
    }) => {
      if (testID && onAccessibilityAction) ctrl.actionHandlers.set(testID, onAccessibilityAction);
      return createElement(
        'button',
        {
          'data-actions': accessibilityActions ? JSON.stringify(accessibilityActions) : undefined,
          onClick: onPress,
          onContextMenu: onLongPress,
          'aria-label': accessibilityLabel,
          'data-state': accessibilityState ? JSON.stringify(accessibilityState) : undefined,
          'data-feedback': feedback,
          'data-style': JSON.stringify(flattenStyle(style)),
          'data-testid': testID,
        },
        children,
      );
    },
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

afterEach(() => {
  cleanup();
  ctrl.os = 'ios';
  ctrl.actionHandlers.clear();
});

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

  // Home's rows: the shelf look, unchanged by the list look below.
  it('keeps a shelf row at 12pt above and below, 4pt to the subtitle, by default', () => {
    render(<ArtRow art={null} artSize="regular" title="Garage Board" subtitle="Kilter · 40°" testID="row" />);
    expect(styleOf(screen.getByTestId('row')).paddingVertical).toBe(12);
    expect(styleOf(screen.getByText('Garage Board').parentElement).gap).toBe(4);
  });

  // The board picker's rows: a list to choose from.
  it('sets a list row in body, regular until selected, 10pt above and below and 2pt to the subtitle', () => {
    const { rerender } = render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Crux Homewall"
        titleVariant="body"
        subtitle="Crux · 10 x 10"
        onPress={vi.fn()}
        testID="row"
      />,
    );
    const title = () => screen.getByText('Crux Homewall');
    expect(title().getAttribute('data-variant')).toBe('body');
    expect(title().getAttribute('data-emphasized')).toBe('false');
    expect(styleOf(screen.getByTestId('row')).paddingVertical).toBe(10);
    expect(styleOf(title().parentElement).gap).toBe(2);

    rerender(
      <ArtRow
        art={null}
        artSize="regular"
        title="Crux Homewall"
        titleVariant="body"
        subtitle="Crux · 10 x 10"
        selected
        onPress={vi.fn()}
        testID="row"
      />,
    );
    expect(title().getAttribute('data-variant')).toBe('body');
    expect(title().getAttribute('data-emphasized')).toBe('true');
    expect(styleOf(screen.getByTestId('row')).paddingVertical).toBe(10);
    expect(styleOf(screen.getByTestId('row')).backgroundColor).toBe('#SELECTION_FILL');
  });

  it('puts the list padding on the target when a control sits beside it', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Crux Homewall"
        titleVariant="body"
        accessory={<u data-testid="menu" />}
        onPress={vi.fn()}
        testID="row"
      />,
    );
    expect(styleOf(screen.getByTestId('row')).paddingVertical).toBe(10);
    expect(styleOf(screen.getByTestId('row').parentElement).paddingVertical).toBeUndefined();
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
    const titleLine = styleOf(title.parentElement);
    expect(titleLine.flexDirection).toBe('row');
    // At an accessibility text size the pill drops under the title instead of
    // squeezing it to a few characters.
    expect(titleLine.flexWrap).toBe('wrap');
    expect(titleLine.rowGap).toBeGreaterThan(0);
  });

  it('draws a control accessory beside the row target, so it is focusable and its tap is its own', () => {
    const onPress = vi.fn();
    const onMenu = vi.fn();
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        accessory={
          <button type="button" aria-label="Board actions" onClick={onMenu}>
            ⋯
          </button>
        }
        onPress={onPress}
        accessibilityLabel="Garage Board"
        testID="row"
      />,
    );
    const row = screen.getByTestId('row');
    const menu = screen.getByRole('button', { name: 'Board actions' });
    expect(row.contains(menu)).toBe(false);
    expect(row.parentElement?.contains(menu)).toBe(true);
    fireEvent.click(menu);
    expect(onMenu).toHaveBeenCalledOnce();
    expect(onPress).not.toHaveBeenCalled();
  });

  // A ⋯ menu's rows, reachable from the row itself by VoiceOver.
  it('publishes its own actions after the long press and routes them back', () => {
    const onLongPress = vi.fn();
    const onAccessibilityAction = vi.fn();
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        onPress={vi.fn()}
        onLongPress={onLongPress}
        longPressAccessibilityLabel="Board actions"
        accessibilityActions={[{ name: 'details', label: 'Details' }]}
        onAccessibilityAction={onAccessibilityAction}
        testID="row"
      />,
    );
    expect(JSON.parse(screen.getByTestId('row').getAttribute('data-actions') ?? '[]')).toEqual([
      { name: 'longpress', label: 'Board actions' },
      { name: 'details', label: 'Details' },
    ]);
    const handle = ctrl.actionHandlers.get('row');
    handle?.({ nativeEvent: { actionName: 'details' } });
    expect(onAccessibilityAction).toHaveBeenCalledOnce();
    expect(onLongPress).not.toHaveBeenCalled();
    handle?.({ nativeEvent: { actionName: 'longpress' } });
    expect(onLongPress).toHaveBeenCalledOnce();
    expect(onAccessibilityAction).toHaveBeenCalledOnce();
  });

  // A hold menu's anchor wraps the row's own target, never the ⋯ beside it.
  it('wraps only the row target, leaving the control outside the wrapper', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        accessory={
          <button type="button" aria-label="Board actions">
            ⋯
          </button>
        }
        onPress={vi.fn()}
        wrapTarget={(target) => <div data-testid="hold-anchor">{target}</div>}
        testID="row"
      />,
    );
    const anchor = screen.getByTestId('hold-anchor');
    expect(anchor.contains(screen.getByTestId('row'))).toBe(true);
    expect(anchor.contains(screen.getByRole('button', { name: 'Board actions' }))).toBe(false);
  });

  it('wraps the whole row when there is no control', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        accessory="chevron"
        onPress={vi.fn()}
        wrapTarget={(target) => <div data-testid="hold-anchor">{target}</div>}
        testID="row"
      />,
    );
    expect(screen.getByTestId('hold-anchor').contains(screen.getByTestId('row'))).toBe(true);
  });

  it('keeps the plain row box when a control sits beside the target', () => {
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        accessory={<u data-testid="menu" />}
        selected
        onPress={vi.fn()}
        testID="row"
      />,
    );
    const target = styleOf(screen.getByTestId('row'));
    const outer = styleOf(screen.getByTestId('row').parentElement);
    const plain = insetGroupedRowStyles.row;
    // Leading gutter and vertical padding on the target, trailing gutter on the row.
    expect(target.paddingStart).toBe(plain.paddingHorizontal);
    expect(target.paddingEnd).toBeUndefined();
    expect(target.paddingVertical).toBe(plain.paddingVertical);
    expect(target.minHeight).toBe(plain.minHeight);
    expect(target.gap).toBe(plain.gap);
    expect(outer.paddingEnd).toBe(plain.paddingHorizontal);
    expect(outer.gap).toBe(plain.gap);
    // The wash spans the control too.
    expect(outer.backgroundColor).toBe('#SELECTION_FILL');
    expect(target.backgroundColor).toBeUndefined();
  });

  it('keeps chevron and checkmark inside the row target', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" accessory="chevron" onPress={vi.fn()} testID="row" />);
    expect(screen.getByTestId('row').querySelector('[data-icon="chevron.right"]')).not.toBeNull();
    expect(styleOf(screen.getByTestId('row')).paddingHorizontal).toBe(16);
  });

  it('publishes the long press as a labelled accessibility action that runs it', () => {
    const onLongPress = vi.fn();
    render(
      <ArtRow
        art={null}
        artSize="regular"
        title="Garage Board"
        onPress={vi.fn()}
        onLongPress={onLongPress}
        longPressAccessibilityLabel="Board actions"
        testID="row"
      />,
    );
    expect(JSON.parse(screen.getByTestId('row').getAttribute('data-actions') ?? 'null')).toEqual([
      { name: 'longpress', label: 'Board actions' },
    ]);
    ctrl.actionHandlers.get('row')?.({ nativeEvent: { actionName: 'longpress' } });
    expect(onLongPress).toHaveBeenCalledOnce();
    ctrl.actionHandlers.get('row')?.({ nativeEvent: { actionName: 'activate' } });
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('leaves an unlabelled long press out on iOS, where VoiceOver would read its raw name', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" onLongPress={vi.fn()} testID="row" />);
    expect(screen.getByTestId('row').getAttribute('data-actions')).toBeNull();
    cleanup();
    ctrl.os = 'android';
    render(<ArtRow art={null} artSize="regular" title="Board" onLongPress={vi.fn()} testID="row" />);
    expect(JSON.parse(screen.getByTestId('row').getAttribute('data-actions') ?? 'null')).toEqual([
      { name: 'longpress' },
    ]);
  });

  it('publishes no actions on a row without a long press', () => {
    render(<ArtRow art={null} artSize="regular" title="Board" onPress={vi.fn()} testID="row" />);
    expect(screen.getByTestId('row').getAttribute('data-actions')).toBeNull();
  });
});
