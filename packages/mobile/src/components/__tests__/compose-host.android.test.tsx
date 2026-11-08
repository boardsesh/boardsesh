// @vitest-environment jsdom
// ComposeHost is the only thing standing between a Compose control and the
// phone's wallpaper palette (#6919): it must always send the brand seed and the
// in-app scheme, and those must win over anything a caller spreads in.
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const hostProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));

vi.mock('@expo/ui', () => ({
  Host: (props: Record<string, unknown> & { children?: ReactNode }) => {
    hostProps.last = props;
    return createElement('div', null, props.children);
  },
}));
const themeFixture = vi.hoisted(() => ({
  brandColors: { primary: '#A78BFA', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
  colorScheme: 'dark' as const,
  m3: {
    background: '#0E0E0E',
    onBackground: '#EDEDED',
    surface: '#1E1E1E',
    onSurface: '#EDEDED',
    surfaceVariant: '#1A1A1A',
    onSurfaceVariant: '#B0B0B0',
    outline: '#8A8A8A',
    outlineVariant: 'rgba(255, 255, 255, 0.12)',
  },
  m3SurfaceContainers: {
    lowest: '#121212',
    low: '#161616',
    base: '#1A1A1A',
    high: '#262626',
    level4: '#2A2A2A',
    highest: '#2E2E2E',
  },
}));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => themeFixture }));

import { ComposeHost, type ComposeHostProps } from '../ComposeHost.android';

describe('ComposeHost', () => {
  it('seeds from the brand fill and pins the in-app scheme', () => {
    render(<ComposeHost matchContents style={{ width: 10 }} />);

    expect(hostProps.last).toMatchObject({
      seedColor: '#7C3AED',
      colorScheme: 'dark',
      matchContents: true,
      style: { width: 10 },
    });
  });

  it('ignores a seed or scheme a caller sneaks past the types', () => {
    const sneaky = { seedColor: '#00FF00', colorScheme: 'light' } as unknown as ComposeHostProps;
    render(<ComposeHost {...sneaky} />);

    expect(hostProps.last).toMatchObject({ seedColor: '#7C3AED', colorScheme: 'dark' });
  });

  it('pins the Compose surface roles to the theme so menus and dialogs stay neutral', () => {
    render(<ComposeHost />);

    expect(hostProps.last?.colorOverrides).toEqual({
      background: '#0E0E0EFF',
      onBackground: '#EDEDEDFF',
      surface: '#1E1E1EFF',
      surfaceDim: '#0E0E0EFF',
      surfaceBright: '#2E2E2EFF',
      surfaceContainerLowest: '#121212FF',
      surfaceContainerLow: '#1E1E1EFF',
      surfaceContainer: '#262626FF',
      surfaceContainerHigh: '#2A2A2AFF',
      surfaceContainerHighest: '#2E2E2EFF',
      surfaceVariant: '#1A1A1AFF',
      onSurface: '#EDEDEDFF',
      onSurfaceVariant: '#B0B0B0FF',
      outline: '#8A8A8AFF',
      // The translucent hairline keeps its alpha: 0.12 × 255 rounds to 0x1F.
      outlineVariant: '#FFFFFF1F',
      // The surface itself, so tonal elevation lays no violet over it.
      surfaceTint: '#1E1E1EFF',
    });
  });

  it('keeps the same override object across re-renders of one theme', () => {
    const { rerender } = render(<ComposeHost matchContents />);
    const first = hostProps.last?.colorOverrides;
    rerender(<ComposeHost matchContents={false} />);

    expect(hostProps.last?.colorOverrides).toBe(first);
  });

  it('a caller cannot replace the overrides', () => {
    const sneaky = { colorOverrides: { surface: '#00FF00FF' } } as unknown as ComposeHostProps;
    render(<ComposeHost {...sneaky} />);

    expect(hostProps.last?.colorOverrides).toMatchObject({ surface: '#1E1E1EFF' });
  });
});
