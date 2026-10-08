// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextInput as NativeTextInput, TextInputProps } from 'react-native';
const signal = vi.hoisted(() => ({ bold: false, focus: vi.fn(), blur: vi.fn() }));
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => signal.bold }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ textStyles: { body: { fontSize: 17, lineHeight: 22, fontWeight: '400' } } }),
}));
function flatten(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(10).filter(Boolean));
}
function InputHost({
  ref,
  style,
  allowFontScaling,
  maxFontSizeMultiplier,
  onFocus,
  onBlur,
  onChangeText,
  value,
  testID,
}: TextInputProps & { ref?: Ref<{ focus: () => void; blur: () => void }> }) {
  useImperativeHandle(ref, () => ({ focus: signal.focus, blur: signal.blur }));
  return createElement('input', {
    'data-testid': testID,
    'data-style': JSON.stringify(flatten(style)),
    'data-scaling': String(allowFontScaling),
    'data-cap': maxFontSizeMultiplier,
    onFocus,
    onBlur,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
    value: value ?? '',
  });
}
vi.mock('react-native', () => ({ TextInput: InputHost, StyleSheet: { flatten } }));
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
    it('honors explicit chrome scaling overrides', () => {
      const screen = render(<Input maxFontSizeMultiplier={1.2} />);
      expect(screen.getByRole('textbox').getAttribute('data-cap')).toBe('1.2');
    });
  });
}
