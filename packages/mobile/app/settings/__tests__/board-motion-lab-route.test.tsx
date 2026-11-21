// @vitest-environment jsdom
//
// The board motion lab's route guard (docs/rendering/board-motion-lab.md). A deep link
// reaches it directly, so it checks the Developer page's dev-tools access, and
// it only loads the lab's screen once access is confirmed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const route = vi.hoisted(() => ({
  access: { showDevTools: false, devToolsLoading: false },
  loadScreen: vi.fn(),
}));

vi.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => createElement('div', { 'data-testid': 'redirect' }, href),
}));
vi.mock('react-native', () => ({
  ActivityIndicator: () => createElement('div', { 'data-testid': 'spinner' }),
  StyleSheet: { create: <Styles,>(styles: Styles) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { groupedBackground: '#000000' } }),
}));
vi.mock('../../../src/components/settings/developer/use-developer-settings-access', () => ({
  useDeveloperSettingsAccess: () => route.access,
}));
vi.mock('../../../src/components/board-motion-lab/load', () => ({
  loadBoardMotionLabScreen: route.loadScreen,
}));

const { default: BoardMotionLabRoute } = await import('../board-motion-lab');

function LabScreenStub() {
  return createElement('div', { 'data-testid': 'lab' });
}

beforeEach(() => {
  route.loadScreen.mockReset();
  route.loadScreen.mockReturnValue(LabScreenStub);
});

afterEach(() => {
  cleanup();
  route.access = { showDevTools: false, devToolsLoading: false };
});

describe('the board motion lab route', () => {
  it('sends a climber without dev tools back to Settings', () => {
    render(createElement(BoardMotionLabRoute));
    expect(screen.getByTestId('redirect').textContent).toBe('/settings');
    expect(route.loadScreen).not.toHaveBeenCalled();
  });

  it('shows a spinner while access is loading, without loading the lab', () => {
    route.access = { showDevTools: false, devToolsLoading: true };
    render(createElement(BoardMotionLabRoute));
    expect(screen.getByTestId('spinner')).toBeTruthy();
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(route.loadScreen).not.toHaveBeenCalled();
  });

  it('opens the lab for a tester', () => {
    route.access = { showDevTools: true, devToolsLoading: false };
    render(createElement(BoardMotionLabRoute));
    expect(screen.getByTestId('lab')).toBeTruthy();
    expect(screen.queryByTestId('redirect')).toBeNull();
    expect(route.loadScreen).toHaveBeenCalledOnce();
  });
});
