// @vitest-environment jsdom
import { createElement, useState, type ReactNode } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ haptic: vi.fn(), submit: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: mocks.haptic }));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, disabled, 'aria-label': accessibilityLabel }, children),
  View: ({
    children,
    pointerEvents,
    accessibilityElementsHidden,
  }: {
    children: ReactNode;
    pointerEvents: string;
    accessibilityElementsHidden: boolean;
  }) =>
    createElement(
      'div',
      { 'data-pointer-events': pointerEvents, 'aria-hidden': accessibilityElementsHidden },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('span', { onClick: onPress, 'data-native-button': true }, title),
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
