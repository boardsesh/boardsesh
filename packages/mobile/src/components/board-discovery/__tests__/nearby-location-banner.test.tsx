// @vitest-environment jsdom
//
// The foot of the board picker while location is off: the line (the shipped
// en-US catalog), and the one button for the permission state it is in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';

type Children = { children?: ReactNode };
const settingsCtrl = vi.hoisted(() => ({ canOpen: true }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 0.5 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      return typeof value === 'string' ? value : key;
    },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, color }: Children & { color?: string }) =>
    createElement('span', { 'data-color': color ?? 'none' }, children),
}));
vi.mock('../../Card', () => ({ Card: ({ children }: Children) => createElement('section', null, children) }));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    onPress,
    variant,
    icon,
  }: {
    title: string;
    onPress: () => void;
    variant?: string;
    icon?: string;
  }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-variant': variant, 'data-icon': icon }, title),
}));
vi.mock('../../../lib/open-app-settings', () => ({ canOpenAppSettings: () => settingsCtrl.canOpen }));

import { NearbyLocationBanner } from '../NearbyLocationBanner';

const handlers = { onAllowLocation: vi.fn(), onOpenSettings: vi.fn() };

beforeEach(() => {
  settingsCtrl.canOpen = true;
  handlers.onAllowLocation.mockClear();
  handlers.onOpenSettings.mockClear();
});
afterEach(cleanup);

const LINE = 'Location is off. Turn it on to see boards near you.';

describe('NearbyLocationBanner', () => {
  it('asks for location while the prompt can still ask', () => {
    render(<NearbyLocationBanner permission="ask" {...handlers} />);
    expect(screen.getByText(LINE).getAttribute('data-color')).toBe('none');
    const allow = screen.getByRole('button', { name: 'Allow location' });
    expect(allow.getAttribute('data-variant')).toBe('tonal');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(allow);
    expect(handlers.onAllowLocation).toHaveBeenCalledOnce();
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
  });

  it('sends the climber to Settings once only Settings can turn it on', () => {
    render(<NearbyLocationBanner permission="blocked" {...handlers} />);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(handlers.onOpenSettings).toHaveBeenCalledOnce();
    expect(handlers.onAllowLocation).not.toHaveBeenCalled();
  });

  it('keeps the line without a button where Settings cannot be opened', () => {
    settingsCtrl.canOpen = false;
    render(<NearbyLocationBanner permission="blocked" {...handlers} />);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
