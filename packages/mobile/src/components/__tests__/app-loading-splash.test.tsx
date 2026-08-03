// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the platform branch under test.
const platformState = vi.hoisted(() => ({ os: 'web' as string }));

// Minimal RN surface: `View` becomes a <div> so the placeholder is queryable.
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.os;
    },
  },
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'splash' }, children),
}));

// The real logo renders an expo-image the node/jsdom env can't load, and pulls
// in a static png require Metro resolves but Vitest doesn't.
vi.mock('../BoardseshLogo', () => ({
  BoardseshLogo: ({ size }: { size?: number }) => createElement('span', { 'data-size': size }, 'logo'),
}));

import { AppLoadingSplash } from '../AppLoadingSplash';

describe('AppLoadingSplash', () => {
  // Each test sets the platform it needs; reset so a case that forgets can't
  // inherit the previous one's OS.
  beforeEach(() => {
    platformState.os = 'web';
  });

  it('paints the logo on web, where there is no OS splash to cover a blank render', () => {
    render(createElement(AppLoadingSplash));

    expect(screen.getByTestId('splash')).toBeTruthy();
    expect(screen.getByText('logo')).toBeTruthy();
  });

  it.each(['ios', 'android'])('renders nothing on %s, leaving the OS splash as the only mark', (os) => {
    platformState.os = os;
    const { container } = render(createElement(AppLoadingSplash));

    expect(container.firstChild).toBeNull();
  });
});
