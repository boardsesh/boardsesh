// @vitest-environment jsdom
import { cloneElement, createElement, type ReactElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ platform: { OS: 'ios', Version: 26, isPad: false }, reduceMotion: false }));
vi.mock('react-native', () => ({
  Platform: settings.platform,
  StyleSheet: { flatten: (style: unknown) => style },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress?: (event: Event) => void;
    accessibilityLabel: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { subtle: 0.7 } }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => settings.reduceMotion }));
vi.mock('expo-router', () => {
  const Link = Object.assign(
    ({
      children,
      onPress,
    }: {
      children: ReactElement<{ onPress?: (event: Event) => void }>;
      onPress: (event: Event) => void;
    }) => cloneElement(children, { onPress }),
    {
      AppleZoom: ({
        children,
        onPress,
      }: {
        children: ReactElement<{ onPress?: (event: Event) => void }>;
        onPress?: (event: Event) => void;
      }) => createElement('div', { 'data-testid': 'native-zoom-source' }, cloneElement(children, { onPress })),
    },
  );
  return { Link };
});

import { AccessoryPlayLink } from '../AccessoryPlayLink';

beforeEach(() => {
  settings.platform.OS = 'ios';
  settings.platform.Version = 26;
  settings.platform.isPad = false;
  settings.reduceMotion = false;
});

function renderLink(zoomSourceRetained = true) {
  const onOpen = vi.fn();
  const onPrepare = vi.fn(() => true);
  render(
    <AccessoryPlayLink
      zoomSourceRetained={zoomSourceRetained}
      accessibilityLabel="My project"
      onOpen={onOpen}
      onPrepare={onPrepare}
    >
      Project
    </AccessoryPlayLink>,
  );
  return { onOpen, onPrepare };
}

describe('accessory player navigation', () => {
  it('uses the opener for floating hosts that unmount under the player', () => {
    const callbacks = renderLink(false);
    fireEvent.click(screen.getByRole('button', { name: 'My project' }));
    expect(callbacks.onOpen).toHaveBeenCalledOnce();
    expect(callbacks.onPrepare).not.toHaveBeenCalled();
    expect(screen.queryByTestId('native-zoom-source')).toBeNull();
  });
  it('prevents navigation when the retained accessory has no live queue head', () => {
    const callbacks = renderLink();
    callbacks.onPrepare.mockReturnValue(false);
    const cancelled = !screen
      .getByRole('button', { name: 'My project' })
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cancelled).toBe(true);
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });
  it('stages the queue head before Link owns the zoom navigation', () => {
    const callbacks = renderLink();
    fireEvent.click(screen.getByRole('button', { name: 'My project' }));
    expect(callbacks.onPrepare).toHaveBeenCalledOnce();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(screen.getByTestId('native-zoom-source')).toBeDefined();
  });

  it.each(['android', 'web', 'ipad', 'older-ios', 'reduce-motion'])('uses the existing opener for %s', (mode) => {
    if (mode === 'android' || mode === 'web') settings.platform.OS = mode;
    if (mode === 'ipad') settings.platform.isPad = true;
    if (mode === 'older-ios') settings.platform.Version = 17;
    if (mode === 'reduce-motion') settings.reduceMotion = true;
    const callbacks = renderLink();
    fireEvent.click(screen.getByRole('button', { name: 'My project' }));
    expect(callbacks.onOpen).toHaveBeenCalledOnce();
    expect(callbacks.onPrepare).not.toHaveBeenCalled();
    expect(screen.queryByTestId('native-zoom-source')).toBeNull();
  });
});
