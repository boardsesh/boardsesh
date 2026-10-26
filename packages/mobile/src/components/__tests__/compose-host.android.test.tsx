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
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#A78BFA', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
    colorScheme: 'dark',
  }),
}));

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
});
