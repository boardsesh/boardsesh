// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('expo-router', () => {
  const Stack = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-stack': true }, children);
  Stack.Screen = ({ name }: { name: string }) => createElement('span', { 'data-screen': name });
  return { Stack };
});
vi.mock('../../../src/components/launch-update/hold-until-launch-ready', () => ({
  holdUntilLaunchReady: <Props extends object>(Component: (props: Props) => ReactNode) => Component,
}));
vi.mock('../../../src/hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000' } }),
}));
vi.mock('../../../src/components/ble/DevicePickerSheetHost', () => ({
  DevicePickerSheetHost: ({ registerExternal }: { registerExternal?: boolean }) =>
    createElement('div', { 'data-device-picker-host': String(registerExternal === true) }),
}));

import WallDisplayLayout from '../_layout';
import { isWallDisplayOpen } from '../../../src/lib/wall-display-presence';

describe('Wall display layout', () => {
  it('hosts the Bluetooth device picker itself, so Connect presents over the kiosk', () => {
    // An app-root picker would present underneath this transparentModal, out of reach.
    const { container } = render(<WallDisplayLayout />);
    expect(container.querySelector('[data-device-picker-host="true"]')).not.toBeNull();
  });

  it('tells the shell the display is up for as long as it is in the stack', () => {
    expect(isWallDisplayOpen()).toBe(false);
    const { unmount } = render(<WallDisplayLayout />);
    expect(isWallDisplayOpen()).toBe(true);
    unmount();
    expect(isWallDisplayOpen()).toBe(false);
  });

  it('keeps its Settings stack beside the kiosk', () => {
    const { container } = render(<WallDisplayLayout />);
    const screens = Array.from(container.querySelectorAll('[data-screen]')).map((screen) =>
      screen.getAttribute('data-screen'),
    );
    expect(screens).toEqual(['index', 'settings']);
  });
});
