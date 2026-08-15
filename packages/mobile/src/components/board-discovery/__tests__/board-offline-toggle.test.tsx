// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 4 }) }));
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
