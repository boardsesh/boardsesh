// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ButtonProps } from '../../Button.types';
import { opacity } from '../../../theme/tokens';

const mocks = vi.hoisted(() => ({ haptic: vi.fn(), submit: vi.fn(), nativeButton: vi.fn(), pressable: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: mocks.haptic }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  Pressable: (props: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
    accessibilityState: { disabled: boolean; busy: boolean };
    style: (state: { pressed: boolean }) => unknown;
  }) => {
    mocks.pressable(props);
    return createElement(
      'button',
      {
        onClick: props.onPress,
        disabled: props.disabled,
        'aria-label': props.accessibilityLabel,
        'aria-disabled': props.accessibilityState.disabled,
        'aria-busy': props.accessibilityState.busy,
        'data-style': JSON.stringify(props.style({ pressed: false })),
      },
      props.children,
    );
  },
  View: ({
    children,
    pointerEvents,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children: ReactNode;
    pointerEvents: string;
    accessibilityElementsHidden: boolean;
    importantForAccessibility: string;
  }) =>
    createElement(
      'div',
      {
        'data-pointer-events': pointerEvents,
        'aria-hidden': accessibilityElementsHidden,
        'data-important-for-accessibility': importantForAccessibility,
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../Button', () => ({
  Button: (props: ButtonProps) => {
    mocks.nativeButton(props);
    return createElement('span', { onClick: props.onPress, 'data-native-button': true }, props.title);
  },
}));
const { TickActionButton } = await import('../TickActionButton.ios');
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Form({ disabled = false, loading = false }: { disabled?: boolean; loading?: boolean }) {
  const [comment, setComment] = useState('');
  return (
    <>
      <input aria-label="Note" value={comment} onChange={(event) => setComment(event.target.value)} />
      <TickActionButton
        title="Attempt"
        disabled={disabled}
        loading={loading}
        onPress={() => mocks.submit(comment)}
        style={{ flex: 1, height: 50 }}
      />
    </>
  );
}

it('submits the latest note once through the RN tap owner', () => {
  const { container } = render(<Form />);
  fireEvent.focus(screen.getByLabelText('Note'));
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Close on the last move' } });
  fireEvent.click(screen.getByRole('button', { name: 'Attempt' }));
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith('Close on the last move');
  expect(mocks.haptic).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[data-pointer-events="none"]')?.getAttribute('aria-hidden')).toBe('true');
});

it.each([{ disabled: true }, { loading: true }])('keeps blocked actions disabled after typing: %j', (state) => {
  render(<Form {...state} />);
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Still writing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Attempt' }));
  expect(mocks.submit).not.toHaveBeenCalled();
  expect(mocks.haptic).not.toHaveBeenCalled();
});

it.each(['tonal', 'filled'] as const)('preserves the pinned height of the %s native surface', (variant) => {
  render(<TickActionButton title="Log tick" onPress={vi.fn()} variant={variant} style={{ flex: 1, height: 48 }} />);
  expect(mocks.nativeButton.mock.lastCall?.[0].style).toEqual({ width: '100%', height: 48 });
});

function restingStyle(button: HTMLElement): Record<string, unknown> {
  const styles = JSON.parse(button.getAttribute('data-style') ?? '[]') as (Record<string, unknown> | null)[];
  return Object.assign({}, ...styles.filter(Boolean)) as Record<string, unknown>;
}

it.each([undefined, 'filled'] as const)(
  'dims disabled %s filled paint while keeping the RN action blocked',
  (variant) => {
    const { container } = render(
      <TickActionButton title="Send" onPress={mocks.submit} variant={variant} disabled style={{ height: 48 }} />,
    );
    const outer = screen.getByRole('button', { name: 'Send' });
    expect((outer as HTMLButtonElement).disabled).toBe(true);
    expect(outer.getAttribute('aria-disabled')).toBe('true');
    expect(outer.getAttribute('aria-busy')).toBe('false');
    expect(restingStyle(outer)).toEqual({ height: 48, opacity: opacity.disabled });
    const nativeProps = mocks.nativeButton.mock.lastCall?.[0] as ButtonProps;
    expect(nativeProps.disabled).toBe(false);
    expect(nativeProps.haptic).toBe(false);
    expect(nativeProps.variant).toBe(variant);
    const decoration = container.querySelector('[data-pointer-events="none"]');
    expect(decoration?.getAttribute('aria-hidden')).toBe('true');
    expect(decoration?.getAttribute('data-important-for-accessibility')).toBe('no-hide-descendants');
    fireEvent.click(outer);
    nativeProps.onPress();
    // Invoke the owner directly too: its guard still protects stale/native taps.
    const outerProps = mocks.pressable.mock.lastCall?.[0] as {
      onPress: () => void;
      style: (state: { pressed: boolean }) => (Record<string, unknown> | undefined)[];
    };
    const pressedStyle = Object.assign({}, ...outerProps.style({ pressed: true }).filter(Boolean)) as Record<
      string,
      unknown
    >;
    expect(pressedStyle.opacity).toBe(opacity.disabled);
    outerProps.onPress();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.haptic).not.toHaveBeenCalled();
  },
);

it.each([
  { variant: 'filled', disabled: false, loading: false },
  { variant: 'tonal', disabled: true, loading: false },
  { variant: 'filled', disabled: false, loading: true },
  { variant: 'filled', disabled: true, loading: true },
] as const)('preserves enabled, tonal and loading rendering: %j', (state) => {
  render(<TickActionButton title="Log tick" onPress={mocks.submit} {...state} />);
  const outer = screen.getByRole('button', { name: 'Log tick' });
  expect(restingStyle(outer).opacity).toBeUndefined();
  expect((outer as HTMLButtonElement).disabled).toBe(state.disabled || state.loading);
  expect(outer.getAttribute('aria-disabled')).toBe(String(state.disabled || state.loading));
  expect(outer.getAttribute('aria-busy')).toBe(String(state.loading));
  const nativeProps = mocks.nativeButton.mock.lastCall?.[0] as ButtonProps;
  expect(nativeProps.disabled).toBe(state.disabled);
  expect(nativeProps.loading).toBe(state.loading);
  expect(nativeProps.variant).toBe(state.variant);
});
