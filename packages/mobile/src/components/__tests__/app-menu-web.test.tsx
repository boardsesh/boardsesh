// @vitest-environment jsdom
// The browser AppMenu's glyph anchor: a 44pt circle by default, or the caller's
// toolbar slot when it passes `anchorSize`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, isValidElement, useImperativeHandle, type ReactNode, type Ref } from 'react';

type MeasureCallback = (x: number, y: number, width: number, height: number) => void;
type CoordinateAnchor = { x: number; y: number };
type MenuLayoutEvent = { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } };

const nativeMeasurement = vi.hoisted(() => ({
  immediate: true,
  callbacks: [] as MeasureCallback[],
  rectangle: [48, 120, 200, 88] as [number, number, number, number],
  onMenuLayout: undefined as ((event: MenuLayoutEvent) => void) | undefined,
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  View: ({
    children,
    style,
    ref,
    onLayout,
    accessible: _accessible,
    ...props
  }: {
    children?: ReactNode;
    style?: unknown;
    accessible?: boolean;
    ref?: Ref<{ measureInWindow: (callback: MeasureCallback) => void }>;
    onLayout?: (event: MenuLayoutEvent) => void;
  }) => {
    if (onLayout) nativeMeasurement.onMenuLayout = onLayout;
    useImperativeHandle(ref, () => ({
      measureInWindow: (callback: MeasureCallback) => {
        nativeMeasurement.callbacks.push(callback);
        if (nativeMeasurement.immediate) callback(...nativeMeasurement.rectangle);
      },
    }));
    return createElement(
      'div',
      { ...props, 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))) },
      children,
    );
  },
}));
vi.mock('react-native-paper', () => ({
  Menu: Object.assign(
    ({
      anchor,
      children,
      visible,
      onDismiss,
      style,
    }: {
      anchor: ReactNode | CoordinateAnchor;
      children?: ReactNode;
      visible?: boolean;
      onDismiss?: () => void;
      style?: unknown;
    }) =>
      createElement(
        'div',
        {
          'data-menu-visible': String(Boolean(visible)),
          'data-menu-anchor': isValidElement(anchor) ? undefined : JSON.stringify(anchor),
          'data-menu-style': style === undefined ? undefined : JSON.stringify(style),
        },
        isValidElement(anchor) ? anchor : null,
        visible ? children : null,
        visible ? createElement('button', { onClick: onDismiss }, 'Dismiss menu') : null,
      ),
    {
      Item: ({ title, onPress }: { title: string; onPress?: () => void }) =>
        createElement('button', { onClick: onPress }, title),
    },
  ),
  Divider: () => createElement('hr'),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    m3: { error: 'error' },
    systemColors: { label: 'label', secondaryLabel: 'secondaryLabel', tertiaryLabel: 'tertiaryLabel', fill: 'fill' },
  }),
}));
vi.mock('../../hooks/use-typography-styles', () => ({
  useTypographyStyles: <T,>(create: (textStyles: { body: { fontSize: number } }) => T): T =>
    create({ body: { fontSize: 17 } }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8 } }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, style, onPress }: { children?: ReactNode; style?: unknown; onPress?: () => void }) =>
    createElement(
      'button',
      { 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))), onClick: onPress },
      children,
    ),
}));

import { AppMenu } from '../AppMenu.web';
import type { AppMenuHandle, AppMenuProps } from '../AppMenu.types';

const anchorStyle = (container: HTMLElement) =>
  JSON.parse(container.querySelector('button')?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

const menuAnchor = (container: HTMLElement): CoordinateAnchor =>
  JSON.parse(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-anchor') ?? 'null');

const menuVisible = (container: HTMLElement): boolean =>
  container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible') === 'true';

describe('AppMenu (web) glyph anchor', () => {
  const props: AppMenuProps = {
    iconName: 'more',
    iconAppearance: 'plain',
    accessibilityLabel: 'More',
    actions: [],
    onSelectIndex: vi.fn(),
  };

  it('keeps the 44pt circle by default', () => {
    const { container } = render(createElement(AppMenu, props));
    expect(anchorStyle(container)).toMatchObject({ width: 44, height: 44, borderRadius: 22 });
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-style')).toBeNull();
  });

  it('takes the toolbar slot it is given', () => {
    const { container } = render(createElement(AppMenu, { ...props, anchorSize: 38 }));
    expect(anchorStyle(container)).toMatchObject({ width: 38, height: 38, borderRadius: 19 });
  });
});

describe('AppMenu (web) long-press anchor', () => {
  beforeEach(() => {
    nativeMeasurement.immediate = true;
    nativeMeasurement.callbacks = [];
    nativeMeasurement.onMenuLayout = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const renderRowMenu = (overrides: Partial<Extract<AppMenuProps, { trigger: 'longPress' }>> = {}) => {
    const onRowPress = vi.fn();
    const onSelectIndex = vi.fn();
    const menuRef = createRef<AppMenuHandle>();
    const props: Extract<AppMenuProps, { trigger: 'longPress' }> = {
      trigger: 'longPress',
      children: createElement('button', { onClick: onRowPress }, 'Climb row'),
      actions: [{ label: 'Share' }],
      onSelectIndex,
      menuRef,
      ...overrides,
    };
    const result = render(createElement(AppMenu, props));
    const row = result.getByText('Climb row');
    return { ...result, props, menuRef, row, anchor: row.parentElement!, onRowPress, onSelectIndex };
  };

  it('positions the complete menu host in its parent flex row and honors caller width limits', () => {
    const { container, getByText } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        children: createElement('button', null, 'Constrained climb'),
        actions: [{ label: 'Share' }],
        onSelectIndex: vi.fn(),
        maxWidth: 320,
        style: [{ flex: 1, flexDirection: 'row' }, { maxWidth: 240 }],
      }),
    );
    const host = container.firstElementChild;
    expect(JSON.parse(host?.getAttribute('data-style') ?? '{}')).toMatchObject({
      flex: 1,
      flexDirection: 'row',
      minWidth: 0,
      maxWidth: 240,
    });
    // Paper's measuring wrapper must not own the live row: its intrinsic width
    // otherwise makes the grade depend on the length of the climb's name.
    expect(host?.contains(container.querySelector('[data-menu-visible]'))).toBe(true);
    expect(container.querySelector('[data-menu-visible]')?.contains(getByText('Constrained climb'))).toBe(false);
  });

  it('opens on right click and prevents the browser menu without activating the row', () => {
    const { container, anchor, onRowPress, getByText, onSelectIndex } = renderRowMenu();
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(anchor, contextEvent);
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('true');
    expect(onRowPress).not.toHaveBeenCalled();
    fireEvent.click(getByText('Share'));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });

  it('anchors a right-click at viewport coordinates after the page has scrolled', () => {
    const { container, anchor } = renderRowMenu();
    const contextEvent = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 64,
      clientY: 96,
    });
    // Document coordinates include the scroll offset; Paper's coordinate
    // anchors use the viewport, just like measureInWindow.
    Object.defineProperties(contextEvent, { pageX: { value: 304 }, pageY: { value: 896 } });
    fireEvent(anchor, contextEvent);
    expect(menuVisible(container)).toBe(true);
    expect(menuAnchor(container)).toEqual({ x: 64, y: 96 });
  });

  it('opens the overflow menu at the explicitly supplied button position', () => {
    const { container, menuRef } = renderRowMenu();
    act(() => menuRef.current?.open({ x: 350, y: 144 }));
    expect(menuVisible(container)).toBe(true);
    expect(menuAnchor(container)).toEqual({ x: 350, y: 144 });
    expect(nativeMeasurement.callbacks).toHaveLength(0);
  });

  it.each([
    { width: 280, pointerX: 180, expectedLeft: 8, behavior: 'clamps a wide menu inside the viewport' },
    { width: 128, pointerX: 315, expectedLeft: 187, behavior: 'keeps a fitting menu flipped beside the pointer' },
  ])('$behavior after measuring its $width-pixel content', ({ width, pointerX, expectedLeft }) => {
    vi.stubGlobal('innerWidth', 375);
    const onPresented = vi.fn();
    const { container, anchor, getByText, row } = renderRowMenu({ onPresented });
    fireEvent.contextMenu(anchor, { clientX: pointerX, clientY: 96 });
    const onMenuLayout = nativeMeasurement.onMenuLayout;
    if (!onMenuLayout) throw new Error('The visible menu has no layout callback');
    act(() => onMenuLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 320 } } }));
    const popupStyle = JSON.parse(
      container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-style') ?? '{}',
    ) as { left: number };
    expect(menuVisible(container)).toBe(true);
    expect(menuAnchor(container)).toEqual({ x: pointerX, y: 96 });
    expect(popupStyle.left).toBe(expectedLeft);
    expect(popupStyle.left).toBeGreaterThanOrEqual(8);
    expect(popupStyle.left + width).toBeLessThanOrEqual(375 - 8);
    expect(onPresented).toHaveBeenCalledOnce();
    expect(getByText('Climb row')).toBe(row);
  });

  it('keeps the open popup when a hold also raises a context menu at the same point', () => {
    vi.useFakeTimers();
    vi.stubGlobal('innerWidth', 375);
    const { container, anchor, getByText, row } = renderRowMenu();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 180, clientY: 96 }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    const popup = container.querySelector('[data-menu-visible]');
    const onMenuLayout = nativeMeasurement.onMenuLayout;
    if (!popup || !onMenuLayout) throw new Error('The hold did not mount a measurable popup');
    act(() => onMenuLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 320 } } }));
    fireEvent.contextMenu(anchor, { clientX: 180, clientY: 96 });
    expect(menuVisible(container)).toBe(true);
    expect(container.querySelector('[data-menu-visible]')).toBe(popup);
    expect(JSON.parse(popup.getAttribute('data-menu-style') ?? '{}')).toEqual({ left: 8 });
    expect(getByText('Climb row')).toBe(row);
  });

  it('restarts the detached popup when reopened with a new width while keeping the row mounted', () => {
    vi.stubGlobal('innerWidth', 375);
    const { container, menuRef, getByText, row } = renderRowMenu();
    act(() => menuRef.current?.open({ x: 180, y: 96 }));
    const firstPopup = container.querySelector('[data-menu-visible]');
    const firstLayout = nativeMeasurement.onMenuLayout;
    if (!firstPopup || !firstLayout) throw new Error('The first open did not mount a measurable popup');
    act(() => firstLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 320 } } }));
    expect(JSON.parse(firstPopup.getAttribute('data-menu-style') ?? '{}')).toEqual({ left: 8 });
    fireEvent.click(getByText('Dismiss menu'));
    act(() => menuRef.current?.open({ x: 315, y: 144 }));
    const reopenedPopup = container.querySelector('[data-menu-visible]');
    const reopenedLayout = nativeMeasurement.onMenuLayout;
    if (!reopenedPopup || !reopenedLayout) throw new Error('Reopening did not mount a measurable popup');
    expect(menuVisible(container)).toBe(true);
    expect(reopenedPopup).not.toBe(firstPopup);
    expect(firstPopup.isConnected).toBe(false);
    expect(reopenedPopup.getAttribute('data-menu-style')).toBeNull();
    expect(getByText('Climb row')).toBe(row);
    act(() => reopenedLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 128, height: 320 } } }));
    expect(JSON.parse(reopenedPopup.getAttribute('data-menu-style') ?? '{}')).toEqual({ left: 187 });
    expect(getByText('Climb row')).toBe(row);
  });

  it('measures the row bottom when opened without a pointer position', () => {
    const { container, menuRef } = renderRowMenu();
    act(() => menuRef.current?.open());
    expect(menuVisible(container)).toBe(true);
    expect(menuAnchor(container)).toEqual({ x: 48, y: 208 });
    expect(nativeMeasurement.callbacks).toHaveLength(1);
  });

  it('keeps an explicit button position when an older row measurement arrives', () => {
    nativeMeasurement.immediate = false;
    const { container, menuRef } = renderRowMenu();
    act(() => menuRef.current?.open());
    expect(menuVisible(container)).toBe(false);
    act(() => menuRef.current?.open({ x: 350, y: 144 }));
    act(() => nativeMeasurement.callbacks[0](48, 120, 200, 88));
    expect(menuVisible(container)).toBe(true);
    expect(menuAnchor(container)).toEqual({ x: 350, y: 144 });
  });

  it('ignores a pending measurement after the recycled row changes targets', () => {
    nativeMeasurement.immediate = false;
    const { container, menuRef, props, rerender, row } = renderRowMenu({ menuKey: 'first-climb' });
    act(() => menuRef.current?.open());
    rerender(createElement(AppMenu, { ...props, menuKey: 'second-climb' }));
    act(() => nativeMeasurement.callbacks[0](48, 120, 200, 88));
    expect(menuVisible(container)).toBe(false);
    expect(container.contains(row)).toBe(true);
  });

  it('ignores a pending measurement when the row no longer has actions', () => {
    nativeMeasurement.immediate = false;
    const { container, menuRef, props, rerender } = renderRowMenu();
    act(() => menuRef.current?.open());
    rerender(createElement(AppMenu, { ...props, actions: [] }));
    act(() => nativeMeasurement.callbacks[0](48, 120, 200, 88));
    expect(menuVisible(container)).toBe(false);
  });

  it('keeps the same mounted row when the menu opens, closes, or changes targets', () => {
    const { container, menuRef, props, rerender, row, getByText } = renderRowMenu({ menuKey: 'first-climb' });
    act(() => menuRef.current?.open({ x: 80, y: 180 }));
    expect(getByText('Climb row')).toBe(row);
    fireEvent.click(getByText('Dismiss menu'));
    expect(getByText('Climb row')).toBe(row);
    act(() => menuRef.current?.open({ x: 90, y: 190 }));
    rerender(createElement(AppMenu, { ...props, menuKey: 'second-climb' }));
    expect(menuVisible(container)).toBe(false);
    expect(getByText('Climb row')).toBe(row);
  });

  it.each(['Share', 'Dismiss menu'])('returns keyboard focus to the invoking control after %s', (action) => {
    const { container, menuRef, getByText } = renderRowMenu();
    const invokingButton = document.createElement('button');
    container.appendChild(invokingButton);
    invokingButton.focus();
    act(() => menuRef.current?.open({ x: 350, y: 144 }));
    const menuAction = getByText(action);
    menuAction.focus();
    fireEvent.click(menuAction);
    expect(menuVisible(container)).toBe(false);
    expect(document.activeElement).toBe(invokingButton);
  });

  it('leaves the browser context menu available when no app actions exist', () => {
    const { getByText, container } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        children: createElement('button', null, 'Unavailable climb'),
        actions: [],
        onSelectIndex: vi.fn(),
      }),
    );
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(getByText('Unavailable climb'), contextEvent);
    expect(contextEvent.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });

  it('leaves an unavailable row closed when its overflow opener is invoked', () => {
    const { container, menuRef } = renderRowMenu({ actions: [] });
    act(() => menuRef.current?.open({ x: 350, y: 144 }));
    expect(menuVisible(container)).toBe(false);
    expect(nativeMeasurement.callbacks).toHaveLength(0);
  });

  it('opens after a hold and consumes its release click, while the next short tap still activates the row', () => {
    vi.useFakeTimers();
    const { container, anchor, row, onRowPress } = renderRowMenu();
    const pointerEvent = new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 });
    Object.defineProperties(pointerEvent, { pageX: { value: 250 }, pageY: { value: 810 } });
    fireEvent(anchor, pointerEvent);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('true');
    expect(menuAnchor(container)).toEqual({ x: 10, y: 10 });
    fireEvent(anchor, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(row);
    expect(onRowPress).not.toHaveBeenCalled();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(anchor, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(row);
    expect(onRowPress).toHaveBeenCalledOnce();
  });

  it('cancels a hold when a scroll or swipe moves beyond the tap tolerance', () => {
    vi.useFakeTimers();
    const { container, anchor } = renderRowMenu();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    fireEvent(anchor, new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });
});
