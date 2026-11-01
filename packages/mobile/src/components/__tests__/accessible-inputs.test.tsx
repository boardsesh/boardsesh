// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextInputInstance as NativeTextInput, TextInputProps } from 'react-native';
const signal = vi.hoisted(() => ({
  bold: false,
  focus: vi.fn(),
  blur: vi.fn(),
  contentSizeChange: null as null | TextInputProps['onContentSizeChange'],
}));
const reveal = vi.hoisted(() => ({ reveal: vi.fn(), follow: vi.fn(), release: vi.fn() }));
vi.mock('../sheet-scroll-into-view', () => ({ useSheetScrollIntoView: () => reveal }));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => signal.bold }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    textStyles: { body: { fontSize: 17, lineHeight: 22, fontWeight: '400' } },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#ffffff' },
  }),
}));
function flatten(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(10).filter(Boolean));
}
function InputHost({
  ref,
  style,
  allowFontScaling,
  maxFontSizeMultiplier,
  cursorColor,
  selectionColor,
  selectionHandleColor,
  onFocus,
  onBlur,
  onChangeText,
  onContentSizeChange,
  value,
  testID,
}: TextInputProps & { ref?: Ref<{ focus: () => void; blur: () => void }> }) {
  signal.contentSizeChange = onContentSizeChange;
  useImperativeHandle(ref, () => ({ focus: signal.focus, blur: signal.blur }));
  return createElement('input', {
    'data-testid': testID,
    'data-style': JSON.stringify(flatten(style)),
    'data-scaling': String(allowFontScaling),
    'data-cap': maxFontSizeMultiplier,
    'data-cursor': cursorColor,
    'data-selection': selectionColor,
    'data-handle': selectionHandleColor,
    onFocus,
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    value: value ?? '',
  });
}
vi.mock('react-native', () => ({ TextInput: InputHost, StyleSheet: { flatten }, Platform: { OS: 'android' } }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: (props: React.ComponentProps<typeof InputHost>) =>
    createElement(InputHost, { ...props, testID: 'sheet-host' }),
}));
import { AccessibleTextInput } from '../AccessibleTextInput';
import { AccessibleBottomSheetTextInput } from '../AccessibleBottomSheetTextInput';
afterEach(() => {
  cleanup();
  signal.bold = false;
  signal.focus.mockClear();
  signal.blur.mockClear();
  vi.clearAllMocks();
});
for (const [name, Input] of [
  ['plain', AccessibleTextInput],
  ['sheet', AccessibleBottomSheetTextInput],
] as const) {
  describe(`${name} accessible input`, () => {
    it('uses full text scaling and strengthens final caller weight when Bold Text changes', () => {
      const screen = render(<Input style={[{ fontWeight: '500' }, { fontWeight: '600' }]} />);
      const host = screen.getByRole('textbox');
      expect(host.getAttribute('data-scaling')).toBe('true');
      expect(host.getAttribute('data-cap')).toBe('0');
      expect(JSON.parse(host.getAttribute('data-style') ?? '{}')).toMatchObject({
        fontSize: 17,
        lineHeight: 22,
        fontWeight: '600',
      });
      signal.bold = true;
      screen.rerender(<Input style={[{ fontWeight: '500' }, { fontWeight: '600' }]} />);
      expect(JSON.parse(host.getAttribute('data-style') ?? '{}').fontWeight).toBe('700');
      signal.bold = false;
      screen.rerender(<Input style={{ fontWeight: '600' }} />);
      expect(JSON.parse(host.getAttribute('data-style') ?? '{}').fontWeight).toBe('600');
    });
    it('retains the actual host, ref, keyboard callbacks, and controlled editing', () => {
      const ref = createRef<NativeTextInput>();
      const onFocus = vi.fn(),
        onBlur = vi.fn(),
        onChangeText = vi.fn();
      const screen = render(
        <Input ref={ref} value="Beta" onFocus={onFocus} onBlur={onBlur} onChangeText={onChangeText} />,
      );
      const host = screen.getByRole('textbox');
      expect(host.getAttribute('data-testid')).toBe(name === 'sheet' ? 'sheet-host' : null);
      act(() => {
        ref.current?.focus();
        ref.current?.blur();
      });
      expect(signal.focus).toHaveBeenCalledOnce();
      expect(signal.blur).toHaveBeenCalledOnce();
      fireEvent.focus(host);
      fireEvent.blur(host);
      fireEvent.change(host, { target: { value: 'New beta' } });
      expect(onFocus).toHaveBeenCalledOnce();
      expect(onBlur).toHaveBeenCalledOnce();
      expect(onChangeText).toHaveBeenCalledWith('New beta');
    });
    it('gives the caret and handles the brand tint and the highlight a translucent one', () => {
      const host = render(<Input />).getByRole('textbox');
      expect(host.getAttribute('data-cursor')).toBe('#6D28D9');
      expect(host.getAttribute('data-handle')).toBe('#6D28D9');
      expect(host.getAttribute('data-selection')).toBe('rgba(109, 40, 217, 0.4)');
    });
    it('lets a caller override the brand cursor colour', () => {
      const host = render(<Input cursorColor="#000000" />).getByRole('textbox');
      expect(host.getAttribute('data-cursor')).toBe('#000000');
    });
    it('honors explicit chrome scaling overrides', () => {
      const screen = render(<Input maxFontSizeMultiplier={1.2} />);
      expect(screen.getByRole('textbox').getAttribute('data-cap')).toBe('1.2');
    });
  });
}

describe('sheet focus reveal', () => {
  it('composes callbacks and tracks the native host only while focused', () => {
    const ref = createRef<NativeTextInput>();
    const onFocus = vi.fn(),
      onBlur = vi.fn(),
      onContentSizeChange = vi.fn();
    const screen = render(
      <AccessibleBottomSheetTextInput
        ref={ref}
        onFocus={onFocus}
        onBlur={onBlur}
        onContentSizeChange={onContentSizeChange}
      />,
    );
    const host = screen.getByRole('textbox');
    const growth = { nativeEvent: { contentSize: { width: 200, height: 100 } } } as Parameters<
      NonNullable<TextInputProps['onContentSizeChange']>
    >[0];
    act(() => {
      signal.contentSizeChange?.(growth);
    });
    expect(reveal.follow).not.toHaveBeenCalled();
    expect(onContentSizeChange).toHaveBeenCalledWith(growth);
    fireEvent.focus(host);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(reveal.reveal).toHaveBeenCalledWith(ref.current);
    act(() => {
      signal.contentSizeChange?.(growth);
    });
    expect(reveal.follow).toHaveBeenCalledWith(ref.current);
    fireEvent.blur(host);
    expect(onBlur).toHaveBeenCalledOnce();
    expect(reveal.release).toHaveBeenCalledWith(ref.current);
    act(() => {
      signal.contentSizeChange?.(growth);
    });
    expect(reveal.follow).toHaveBeenCalledOnce();
  });

  it('reveals the validation wrapper and releases it when unmounted while focused', () => {
    const target = { measureLayout: vi.fn() };
    const callbackRef = vi.fn();
    const screen = render(
      <AccessibleBottomSheetTextInput ref={callbackRef} sheetRevealTargetRef={{ current: target }} />,
    );
    expect(callbackRef).toHaveBeenCalledWith(expect.objectContaining({ focus: signal.focus }));
    fireEvent.focus(screen.getByRole('textbox'));
    expect(reveal.reveal).toHaveBeenCalledWith(target);
    screen.unmount();
    expect(reveal.release).toHaveBeenCalledWith(target);
    expect(callbackRef).toHaveBeenLastCalledWith(null);
  });
});

it('preserves a callback ref cleanup when the native sheet input unmounts', () => {
  const detach = vi.fn();
  const callbackRef = vi.fn(() => detach);
  const screen = render(<AccessibleBottomSheetTextInput ref={callbackRef} />);
  expect(callbackRef).toHaveBeenCalledWith(expect.objectContaining({ focus: signal.focus }));
  screen.unmount();
  expect(detach).toHaveBeenCalledOnce();
});
