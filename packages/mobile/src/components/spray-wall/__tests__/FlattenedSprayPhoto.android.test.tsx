// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { homographyFromAnchors } from '@boardsesh/spray-wall-geometry';

// The Android branch: the SVG mesh, which must only ever load a local file.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('expo-image', () => ({
  Image: ({ source }: { source: { uri: string } }) =>
    createElement('img', { 'data-testid': 'expo-image', src: source.uri }),
}));
const passthrough =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(tag, null, children);
vi.mock('react-native-svg', () => ({
  default: passthrough('svg'),
  Defs: passthrough('defs'),
  ClipPath: passthrough('clippath'),
  G: passthrough('g'),
  Polygon: () => createElement('polygon'),
  Image: ({ href }: { href: string }) => createElement('image', { 'data-testid': 'svg-image', 'data-href': href }),
}));

const { FlattenedSprayPhoto } = await import('../FlattenedSprayPhoto');

const frame = { width: 2000, height: 1500 };
const SOURCE = {
  layoutId: 9,
  versionId: 3,
  photoUrl: 'https://private.example/photo.jpg',
  photoExpiresAt: 'later',
  photo: { width: 2400, height: 1800 },
  // A soft keystone, so the mesh is several triangles.
  homography: homographyFromAnchors(
    [
      [500, 200],
      [1900, 200],
      [2200, 1700],
      [200, 1700],
    ],
    frame,
  ),
  frame,
  holds: [],
};
const TILE = { width: 110, height: 83 };
const LOCAL = 'file:///data/cache/spray-walls/9-v3.jpg';

afterEach(cleanup);

describe('FlattenedSprayPhoto on Android', () => {
  it('draws every mesh triangle from the local file and nothing else', () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <FlattenedSprayPhoto source={SOURCE} photoUri={LOCAL} tile={TILE} />,
    );
    const images = getAllByTestId('svg-image');
    expect(images.length).toBeGreaterThan(2);
    expect(new Set(images.map((image) => image.getAttribute('data-href')))).toEqual(new Set([LOCAL]));
    expect(queryAllByTestId('expo-image')).toHaveLength(0);
  });

  it.each([SOURCE.photoUrl, 'http://private.example/photo.jpg', 'file://host/photo.jpg', ''])(
    'draws nothing for %s',
    (uri) => {
      const { container } = render(<FlattenedSprayPhoto source={SOURCE} photoUri={uri} tile={TILE} />);
      expect(container.querySelectorAll('image, img')).toHaveLength(0);
    },
  );
});
