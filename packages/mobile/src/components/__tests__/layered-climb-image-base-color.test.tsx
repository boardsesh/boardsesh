// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Style = Record<string, unknown> | false | null | undefined | Style[];
function flatten(style: Style): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style;
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({
    children,
    testID,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: Style;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-background-color': flatten(style).backgroundColor as string | undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) => createElement('img', { src: source.uri }),
}));
vi.mock('../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

import { LayeredClimbImage } from '../LayeredClimbImage';

describe('LayeredClimbImage baseColor', () => {
  it('paints the field colour under a transparent background image', () => {
    const { getByTestId, container } = render(
      <LayeredClimbImage overlayUri={null} backgroundPaths={['/cache/1-v5-cutout.webp']} baseColor="#181225" />,
    );
    const base = getByTestId('layered-climb-image-base');
    expect(base.getAttribute('data-background-color')).toBe('#181225');
    // Under the image, not over it.
    const stack = container.firstElementChild!;
    const children = [...stack.children];
    expect(children.indexOf(base)).toBeLessThan(children.findIndex((child) => child.tagName === 'IMG'));
  });

  it('paints nothing extra without a base colour', () => {
    const { queryByTestId } = render(<LayeredClimbImage overlayUri={null} backgroundPaths={['/cache/1-v5.jpg']} />);
    expect(queryByTestId('layered-climb-image-base')).toBeNull();
  });

  it('leaves a missing background to the grey placeholder', () => {
    const { queryByTestId, getByLabelText } = render(
      <LayeredClimbImage overlayUri={null} backgroundPaths={[]} missingBackgroundCount={1} baseColor="#FFFFFF" />,
    );
    expect(queryByTestId('layered-climb-image-base')).toBeNull();
    expect(getByLabelText('Missing background layer')).toBeTruthy();
  });
});
