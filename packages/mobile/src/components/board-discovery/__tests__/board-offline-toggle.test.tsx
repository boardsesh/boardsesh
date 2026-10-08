// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
  },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: new Proxy({}, { get: () => 4 }),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-testid': 'icon' }) }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('span', { 'data-testid': 'spinner' }),
}));

import { BoardOfflineToggle } from '../BoardOfflineToggle';

afterEach(cleanup);

describe('BoardOfflineToggle', () => {
  it('shows non-actionable activity while shared work finalizes the download', () => {
    const { getByTestId, queryByRole } = render(
      <BoardOfflineToggle state="finalizing" onPress={vi.fn()} accessibilityLabel="Remove board from offline" />,
    );

    expect(getByTestId('spinner')).toBeTruthy();
    expect(queryByRole('button')).toBeNull();
  });
});
