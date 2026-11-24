// @vitest-environment jsdom
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { flatten: (style: unknown) => style },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    testID,
  }: {
    children: ReactNode;
    onPress?: (event: Event) => void;
    accessibilityLabel: string;
    testID?: string;
  }) =>
    createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'data-testid': testID }, children),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { subtle: 0.7 } }));
// The accessory must never hand navigation to a Link: its zoom could freeze the
// player half-way (#8126). Any Link use would throw here.
vi.mock('expo-router', () => ({}));

import { AccessoryPlayLink } from '../AccessoryPlayLink';

describe('accessory player navigation', () => {
  it('opens the player through the same opener as a climb row (#8126)', () => {
    const onOpen = vi.fn();
    render(
      <AccessoryPlayLink testID="mini-player-current-pinned-climb" accessibilityLabel="My project" onOpen={onOpen}>
        Project
      </AccessoryPlayLink>,
    );
    const action = screen.getByTestId('mini-player-current-pinned-climb');
    expect(action).toBe(screen.getByRole('button', { name: 'My project' }));
    fireEvent.click(action);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
