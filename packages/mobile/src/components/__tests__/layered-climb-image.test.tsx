// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

type ImageProps = {
  source?: { uri?: string };
  allowDownscaling?: boolean;
};
vi.mock('expo-image', () => ({
  Image: ({ source, allowDownscaling }: ImageProps) =>
    createElement('img', {
      'data-uri': source?.uri ?? '',
      'data-allow-downscaling': String(allowDownscaling),
    }),
}));

import { LayeredClimbImage } from '../LayeredClimbImage';

function renderedImages(container: HTMLElement) {
  return Array.from(container.querySelectorAll('img'));
}

describe('LayeredClimbImage', () => {
  it('allows downscaling by default so full-size board renders can fit their box', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/background.webp'],
      }),
    );

    expect(renderedImages(container).map((image) => image.getAttribute('data-allow-downscaling'))).toEqual([
      'true',
      'true',
    ]);
  });

  it('can disable downscaling for pre-sized thumbnail sources', () => {
    const { container } = render(
      createElement(LayeredClimbImage, {
        overlayUri: 'file:///overlay.png',
        backgroundPaths: ['/background.webp'],
        allowDownscaling: false,
      }),
    );

    expect(renderedImages(container).map((image) => image.getAttribute('data-allow-downscaling'))).toEqual([
      'false',
      'false',
    ]);
  });
});
