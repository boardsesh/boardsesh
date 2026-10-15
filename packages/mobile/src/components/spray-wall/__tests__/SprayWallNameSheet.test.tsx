// @vitest-environment jsdom
vi.mock('../../AccessibleBottomSheetTextInput', () => ({
  AccessibleBottomSheetTextInput: ({
    value,
    onChangeText,
    onSubmitEditing,
    onFocus,
    placeholder,
    maxLength,
  }: {
    value?: string;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
    onFocus?: () => void;
    placeholder?: string;
    maxLength?: number;
  }) =>
    createElement('input', {
      'data-testid': 'name-input',
      'data-placeholder': placeholder ?? '',
      'data-maxlength': maxLength === undefined ? '' : String(maxLength),
      value: value ?? '',
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
      onFocus,
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') onSubmitEditing?.();
      },
    }),
}));
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
const sheetProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));
const expand = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  Platform: platform,
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'name-field-scroll' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../Sheet', () => ({
  Sheet: (props: { children?: ReactNode; header?: ReactNode; visible: boolean; ref?: { current: unknown } }) => {
    sheetProps.last = props;
    if (props.ref) props.ref.current = { expand };
    return createElement(
      'div',
      { 'data-sheet': 'true', 'data-visible': String(props.visible) },
      props.header,
      props.children,
    );
  },
}));
vi.mock('../../sheet-snap-points', () => ({ MEDIUM_LARGE_SNAP_POINTS: ['50%', '90%'] }));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-typography-styles', () => ({
  useTypographyStyles: (create: (textStyles: { callout: { fontSize: number } }) => unknown) =>
    create({ callout: { fontSize: 16 } }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee', label: '#000', tertiaryLabel: '#aaa' } }),
}));
vi.mock('../../board-discovery/use-spray-wall-builder', () => ({ SPRAY_WALL_NAME_MAX_LENGTH: 100 }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16 }, borderRadius: { lg: 12 } }));

const { SprayWallNameSheet } = await import('../SprayWallNameSheet');

afterEach(() => {
  cleanup();
  platform.OS = 'ios';
  expand.mockClear();
});

function renderSheet(props: Partial<Parameters<typeof SprayWallNameSheet>[0]> = {}) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  const all = { visible: true, name: 'Garage wall', placeholder: "Marco's Spray wall", onDone, onClose, ...props };
  const view = render(createElement(SprayWallNameSheet, all));
  return {
    ...view,
    onDone,
    onClose,
    rerenderSheet: (next: Partial<typeof all>) => view.rerender(createElement(SprayWallNameSheet, { ...all, ...next })),
  };
}

const input = (root: HTMLElement) => root.querySelector('[data-testid="name-input"]') as HTMLInputElement;
const done = (root: HTMLElement) => root.querySelector('[data-testid="sheet-top-bar-trailing"]') as HTMLButtonElement;

describe('SprayWallNameSheet', () => {
  it('opens on the current name, with the default as the placeholder and the name cap', () => {
    const { container } = renderSheet();
    expect(input(container).value).toBe('Garage wall');
    expect(input(container).getAttribute('data-placeholder')).toBe("Marco's Spray wall");
    expect(input(container).getAttribute('data-maxlength')).toBe('100');
  });

  it('hands back the trimmed name on Done, and on the keyboard return', () => {
    const { container, onDone } = renderSheet();
    fireEvent.change(input(container), { target: { value: '  The Cave  ' } });
    fireEvent.click(done(container));
    fireEvent.keyDown(input(container), { key: 'Enter' });
    expect(onDone).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenNthCalledWith(1, 'The Cave');
  });

  it('refuses an empty name', () => {
    const { container, onDone } = renderSheet();
    fireEvent.change(input(container), { target: { value: '   ' } });
    expect(done(container).disabled).toBe(true);
    fireEvent.keyDown(input(container), { key: 'Enter' });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('throws away what was typed when it is cancelled and opened again', () => {
    const { container, onClose, rerenderSheet } = renderSheet();
    fireEvent.change(input(container), { target: { value: 'scratch' } });
    fireEvent.click(container.querySelector('[data-testid="sheet-top-bar-leading"]') as HTMLButtonElement);
    expect(onClose).toHaveBeenCalledOnce();
    rerenderSheet({ visible: false });
    rerenderSheet({ visible: true, name: 'Garage wall' });
    expect(input(container).value).toBe('Garage wall');
  });
});

describe('SprayWallNameSheet sizing', () => {
  it('fits the field on iOS, and keeps fixed detents on Android so the keyboard cannot push it full screen', () => {
    renderSheet();
    expect(sheetProps.last).toMatchObject({ enableDynamicSizing: true, androidContentSized: true });
    cleanup();
    platform.OS = 'android';
    renderSheet();
    expect(sheetProps.last).toMatchObject({ snapPoints: ['50%', '90%'] });
    expect(sheetProps.last?.enableDynamicSizing).toBeUndefined();
  });

  it('keeps Android chrome outside the field scroll without a second keyboard reservation', () => {
    platform.OS = 'android';
    const { container, getByTestId, onDone } = renderSheet();
    expect(sheetProps.last?.header).toBeUndefined();
    expect(sheetProps.last?.scrollable).toBeUndefined();
    const fieldScroll = getByTestId('name-field-scroll');
    expect(fieldScroll.contains(input(container))).toBe(true);
    expect(fieldScroll.contains(done(container))).toBe(false);
    fireEvent.focus(input(container));
    expect(expand).toHaveBeenCalledOnce();
    fireEvent.change(input(container), { target: { value: 'Android garage' } });
    fireEvent.click(done(container));
    expect(onDone).toHaveBeenCalledExactlyOnceWith('Android garage');
  });

  it('names its Cancel for screen readers', () => {
    const { container } = renderSheet();
    expect(container.querySelector('[data-testid="sheet-top-bar-leading"]')?.getAttribute('aria-label')).toBe(
      'comment.cancel',
    );
  });
});
