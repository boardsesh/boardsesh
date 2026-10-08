// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: ({ children, testID, style }: { children?: ReactNode; testID?: string; style?: Record<string, unknown> }) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }, children),
}));
vi.mock('../FlattenedSprayPhoto', () => ({
  FlattenedSprayPhoto: ({ photoUri }: { photoUri: string }) =>
    createElement('div', { 'data-testid': 'flattened', 'data-uri': photoUri }),
}));

const { HoldMaskedPhoto } = await import('../HoldMaskedPhoto.web');

const SOURCE = {
  layoutId: 9,
  versionId: 3,
  photoUrl: 'https://private.example/photo.jpg',
  photoExpiresAt: 'later',
  photo: { width: 2400, height: 1800 },
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  frame: { width: 2400, height: 1800 },
  holds: [],
};

afterEach(cleanup);

describe('HoldMaskedPhoto (web)', () => {
  it('keeps the photo and masks it with CSS, since the web MaskedView drops its children', () => {
    const { getByTestId } = render(
      <HoldMaskedPhoto
        source={SOURCE}
        photoUri={SOURCE.photoUrl}
        tile={{ width: 110, height: 83 }}
        mask={{ path: 'M1 1L5 1L1 5Z', grow: 1, feather: 2 }}
      />,
    );
    expect(getByTestId('flattened').getAttribute('data-uri')).toBe(SOURCE.photoUrl);
    const style = JSON.parse(getByTestId('spray-holds-css-mask').getAttribute('data-style') ?? '{}');
    expect(style.maskImage).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(style.WebkitMaskImage).toBe(style.maskImage);
    expect(style).toMatchObject({ width: 110, height: 83, maskSize: '100% 100%', maskRepeat: 'no-repeat' });
  });
});
