// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type NativeProps = Record<string, unknown> & { children?: ReactNode };
type Modifier = { kind: string; args: unknown[] };

const nativeCalls = vi.hoisted(() => ({
  host: [] as NativeProps[],
  form: [] as NativeProps[],
  textField: [] as NativeProps[],
  button: [] as NativeProps[],
  section: [] as NativeProps[],
}));
const nativeStates = vi.hoisted(() => ({ created: [] as { value: string; set: ReturnType<typeof vi.fn> }[] }));

vi.mock('react-native', () => ({
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  Keyboard: { dismiss: vi.fn() },
  PlatformColor: (name: string) => name,
}));
vi.mock('@expo/ui', () => ({
  Host: (props: NativeProps) => {
    nativeCalls.host.push(props);
    return createElement('div', null, props.children);
  },
}));
vi.mock('@expo/ui/swift-ui', async () => {
  const { useRef } = await import('react');
  const passthrough = ({ children }: NativeProps) => createElement('div', null, children);
  return {
    Form: (props: NativeProps) => {
      nativeCalls.form.push(props);
      return createElement('div', null, props.children);
    },
    Section: (props: NativeProps) => {
      nativeCalls.section.push(props);
      return createElement(
        'section',
        null,
        props.title ? createElement('h2', null, props.title as string) : null,
        props.children,
        props.footer ? createElement('footer', null, props.footer as ReactNode) : null,
      );
    },
    HStack: passthrough,
    Spacer: () => null,
    Image: () => null,
    Text: ({ children }: NativeProps) => createElement('span', null, children),
    // Menu draws its label; its items are children.
    Menu: ({ label, children }: NativeProps) => createElement('div', null, label as ReactNode, children),
    TextField: (props: NativeProps) => {
      nativeCalls.textField.push(props);
      return createElement('input', {
        placeholder: props.placeholder as string,
        onChange: (event: { target: { value: string } }) =>
          (props.onTextChange as (text: string) => void)(event.target.value),
        onFocus: () => (props.onFocusChange as (focused: boolean) => void)(true),
        onBlur: () => (props.onFocusChange as (focused: boolean) => void)(false),
      });
    },
    Button: (props: NativeProps) => {
      nativeCalls.button.push(props);
      const label = props.label as string | undefined;
      return createElement(
        'button',
        {
          type: 'button',
          onClick: props.onPress as () => void,
          'data-system-image': props.systemImage as string | undefined,
          'aria-label': label ?? (findModifier(props, 'accessibilityLabel')?.args[0] as string | undefined),
        },
        label,
        props.children,
      );
    },
    useNativeState: (initial: string) => {
      const ref = useRef<{ value: string; set: ReturnType<typeof vi.fn> } | null>(null);
      if (!ref.current) {
        ref.current = { value: initial, set: vi.fn() };
        nativeStates.created.push(ref.current);
      }
      return ref.current;
    },
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const modifier =
    (kind: string) =>
    (...args: unknown[]) => ({ kind, args });
  return {
    accessibilityLabel: modifier('accessibilityLabel'),
    autocorrectionDisabled: modifier('autocorrectionDisabled'),
    buttonStyle: modifier('buttonStyle'),
    onSubmit: modifier('onSubmit'),
    scrollContentBackground: modifier('scrollContentBackground'),
    scrollDismissesKeyboard: modifier('scrollDismissesKeyboard'),
    submitLabel: modifier('submitLabel'),
    textInputAutocapitalization: modifier('textInputAutocapitalization'),
    tint: modifier('tint'),
    font: modifier('font'),
    foregroundStyle: modifier('foregroundStyle'),
    listRowBackground: modifier('listRowBackground'),
  };
});
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: 'light', brandColors: { primary: '#6D28D9' } }),
}));
vi.mock('../../theme/expo-ui-modifiers', () => ({
  brandControlTint: () => '#6D28D9',
  brandAccentColor: () => '#A78BFA',
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 } }));
// Settings rows have their own tests; here they only need to show up.
vi.mock('../settings-rows.ios', () => ({
  renderSettingsRow: (row: { key: string; kind: string }) =>
    createElement('div', { key: row.key, 'data-settings-row': row.kind }, row.key),
}));

import { ClimbFilterForm } from '../ClimbFilterForm.ios';
import type { ClimbFilterFormModel, ClimbFilterFormRow } from '../ClimbFilterForm.types';

function findModifier(props: NativeProps, kind: string): Modifier | undefined {
  return (props.modifiers as Modifier[] | undefined)?.find((entry) => entry.kind === kind);
}

function lastProps(component: keyof typeof nativeCalls): NativeProps {
  const props = nativeCalls[component].at(-1);
  if (!props) throw new Error(`SwiftUI ${component} was never rendered`);
  return props;
}

const handlers = {
  onChangeText: vi.fn(),
  onClear: vi.fn(),
  onFocus: vi.fn(),
};

function nameRow(value: string): ClimbFilterFormRow {
  return {
    kind: 'name',
    key: 'name',
    value,
    placeholder: 'Climb name',
    accessibilityLabel: 'Name',
    clearLabel: 'Clear',
    ...handlers,
  };
}

function modelWith(value: string, extraRows: ClimbFilterFormRow[] = []): ClimbFilterFormModel {
  return { sections: [{ key: 'name', title: 'Name', rows: [nameRow(value), ...extraRows] }] };
}

beforeEach(() => {
  for (const calls of Object.values(nativeCalls)) calls.length = 0;
  nativeStates.created.length = 0;
  Object.values(handlers).forEach((handler) => handler.mockReset());
});

describe('iOS ClimbFilterForm', () => {
  it('renders one Host that ignores the keyboard safe area and one Form with a hidden scroll background', () => {
    render(<ClimbFilterForm model={modelWith('')} />);

    expect(new Set(nativeCalls.host.map((props) => props.ignoreSafeArea))).toEqual(new Set(['keyboard']));
    expect(lastProps('host').colorScheme).toBe('light');
    expect(nativeCalls.form.length).toBeGreaterThan(0);
    expect(findModifier(lastProps('form'), 'scrollContentBackground')?.args).toEqual(['hidden']);
  });

  it('renders section titles and footers', () => {
    const model: ClimbFilterFormModel = {
      sections: [
        { key: 'name', title: 'Name', footer: 'Recent searches show here', rows: [nameRow('')] },
        { key: 'sort', title: 'Sort', rows: [{ kind: 'nav', key: 'q', label: 'Quick', onPress: vi.fn() }] },
      ],
    };
    const { getByText, queryByText } = render(<ClimbFilterForm model={model} />);

    expect(getByText('Name')).toBeTruthy();
    expect(getByText('Recent searches show here')).toBeTruthy();
    expect(getByText('Sort')).toBeTruthy();
    // Every section gets the opaque card fill.
    expect(nativeCalls.section.every((props) => findModifier(props, 'listRowBackground'))).toBe(true);
    // Settings kinds go through the shared renderer.
    expect(getByText('q')).toBeTruthy();
    expect(queryByText('missing')).toBeNull();
  });

  describe('name row', () => {
    it('never auto-focuses the field', () => {
      render(<ClimbFilterForm model={modelWith('')} />);
      expect(lastProps('textField')).not.toHaveProperty('autoFocus');
      expect(lastProps('textField').placeholder).toBe('Climb name');
    });

    it('reports typing through onChangeText', () => {
      const { getByPlaceholderText } = render(<ClimbFilterForm model={modelWith('')} />);
      fireEvent.change(getByPlaceholderText('Climb name'), { target: { value: 'crimp' } });
      expect(handlers.onChangeText).toHaveBeenCalledWith('crimp');
    });

    it('calls onFocus when the field gains focus, not when it loses it', () => {
      const { getByPlaceholderText } = render(<ClimbFilterForm model={modelWith('')} />);
      fireEvent.blur(getByPlaceholderText('Climb name'));
      expect(handlers.onFocus).not.toHaveBeenCalled();
      fireEvent.focus(getByPlaceholderText('Climb name'));
      expect(handlers.onFocus).toHaveBeenCalledOnce();
    });

    it('shows the clear button only with text, and it calls onClear', () => {
      const empty = render(<ClimbFilterForm model={modelWith('')} />);
      expect(empty.queryByLabelText('Clear')).toBeNull();
      empty.unmount();

      const filled = render(<ClimbFilterForm model={modelWith('crimp')} />);
      const clear = filled.getByLabelText('Clear');
      expect(findModifier(lastProps('button'), 'buttonStyle')?.args).toEqual(['borderless']);
      fireEvent.click(clear);
      expect(handlers.onClear).toHaveBeenCalledOnce();
    });

    it('pushes an outside value change (Reset) into the native state', () => {
      const { rerender } = render(<ClimbFilterForm model={modelWith('crimp')} />);
      const state = nativeStates.created[0];
      expect(state.set).not.toHaveBeenCalled();

      rerender(<ClimbFilterForm model={modelWith('')} />);
      expect(state.set).toHaveBeenCalledExactlyOnceWith('');
    });

    it('does not push the echo of the user own typing', () => {
      const { getByPlaceholderText, rerender } = render(<ClimbFilterForm model={modelWith('')} />);
      const state = nativeStates.created[0];

      fireEvent.change(getByPlaceholderText('Climb name'), { target: { value: 'cr' } });
      rerender(<ClimbFilterForm model={modelWith('cr')} />);

      expect(state.set).not.toHaveBeenCalled();
    });
  });

  describe('menu row', () => {
    const menuRow = (onSelect: (key: string) => void): ClimbFilterFormRow => ({
      kind: 'menu',
      key: 'recent',
      label: 'Recent searches',
      value: 'Beta',
      items: [
        { key: 'a', label: 'Alpha', checked: false },
        { key: 'b', label: 'Beta', checked: true },
      ],
      onSelect,
    });

    it('renders one Button per item and ticks only the checked one', () => {
      const { getByText } = render(<ClimbFilterForm model={modelWith('', [menuRow(vi.fn())])} />);

      const items = nativeCalls.button.filter((props) => props.label);
      expect(items.map((props) => props.label)).toEqual(['Alpha', 'Beta']);
      expect(items.map((props) => props.systemImage)).toEqual([undefined, 'checkmark']);
      expect(getByText('Recent searches')).toBeTruthy();
    });

    it('calls onSelect with the pressed item key', () => {
      const onSelect = vi.fn();
      const { getByLabelText } = render(<ClimbFilterForm model={modelWith('', [menuRow(onSelect)])} />);

      act(() => {
        fireEvent.click(getByLabelText('Alpha'));
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('a');
    });
  });
});
