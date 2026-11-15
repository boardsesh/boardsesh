// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const navigation = vi.hoisted(() => ({ focused: true }));
vi.mock('expo-router', () => ({
  useIsFocused: () => navigation.focused,
  Redirect: ({ href }: { href: string }) => <span>{href}</span>,
}));
vi.mock('../../src/lib/app-entry-route', () => ({ getAppEntryHref: () => '/climbs' }));
import MobileHome from '../index';
import { NavigationEntryProvider } from '../../src/providers/navigation-entry-provider';
afterEach(cleanup);
describe('root launcher navigation', () => {
  it('keeps an anchored launcher inert behind a deep-linked screen', () => {
    navigation.focused = false;
    const screen = render(
      <NavigationEntryProvider href="/dev/stories">
        <MobileHome />
      </NavigationEntryProvider>,
    );
    expect(screen.container.textContent).toBe('');
  });
  it('uses the root destination when the launcher itself gains focus', () => {
    navigation.focused = true;
    const screen = render(
      <NavigationEntryProvider href="/dev/stories">
        <MobileHome />
      </NavigationEntryProvider>,
    );
    expect(screen.getByText('/dev/stories')).toBeTruthy();
  });
  it('preserves the ordinary application launch destination', () => {
    navigation.focused = true;
    expect(render(<MobileHome />).getByText('/climbs')).toBeTruthy();
  });
});
