// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

// A stand-in for the UI-thread reaction: the test drives the zoom by calling the
// registered reaction with a new scale, the way Reanimated would when the
// derived value changes.
const reaction = vi.hoisted(() => ({
  prepare: null as null | (() => boolean),
  react: null as null | ((current: boolean, previous: boolean | null) => void),
  last: null as boolean | null,
}));

const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({
  Platform: platform,
  StyleSheet: { absoluteFill: { position: 'absolute' } },
}));

vi.mock('react-native-reanimated', () => ({
  runOnJS:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
  useAnimatedReaction: (prepare: () => boolean, react: (current: boolean, previous: boolean | null) => void) => {
    reaction.prepare = prepare;
    reaction.react = react;
  },
}));

type ImageProps = {
  source: { uri: string; cacheKey?: string };
  contentFit?: string;
  allowDownscaling?: boolean;
  onError?: () => void;
};
const imageRenders = vi.hoisted(() => [] as ImageProps[]);
vi.mock('expo-image', () => ({
  Image: (props: ImageProps) => {
    imageRenders.push(props);
    return createElement('img', {
      'data-uri': props.source.uri,
      'data-cache-key': props.source.cacheKey,
      onError: props.onError,
    });
  },
}));

import { FullResolutionPhotoLayer, type FullResolutionPhoto } from '../FullResolutionPhotoLayer';

const photo: FullResolutionPhoto = {
  uri: 'https://private.example/full.jpg?sig=1',
  cacheKey: 'spray-full/w/v1',
  minScale: 3,
};

/** Move the board's zoom to `scale` and let the reaction run as the UI thread would. */
function zoomTo(scaleSV: { value: number }, scale: number) {
  scaleSV.value = scale;
  const current = reaction.prepare!();
  act(() => {
    if (current !== reaction.last) reaction.react!(current, reaction.last);
    reaction.last = current;
  });
}

type LayerProps = Parameters<typeof FullResolutionPhotoLayer>[0];

function setup(photoUnderTest: FullResolutionPhoto = photo) {
  platform.OS = 'ios';
  reaction.last = null;
  imageRenders.length = 0;
  const scaleSV = { value: 1 };
  const onError = vi.fn();
  const view = render(
    createElement(FullResolutionPhotoLayer, {
      photo: photoUnderTest,
      scaleSV: scaleSV as unknown as LayerProps['scaleSV'],
      onError,
    }),
  );
  // The initial run, as Reanimated makes on mount.
  zoomTo(scaleSV, 1);
  return { ...view, scaleSV, onError };
}

afterEach(() => cleanup());

describe('FullResolutionPhotoLayer', () => {
  // A 24 MP photo is ~98 MB decoded; most visits never zoom that far.
  it('fetches nothing at rest or below the switch zoom', () => {
    const { container, scaleSV } = setup();
    zoomTo(scaleSV, 2);
    zoomTo(scaleSV, 3);
    expect(container.querySelector('img')).toBeNull();
  });

  it('mounts the full photo once the zoom passes the switch zoom', () => {
    const { container, scaleSV } = setup();
    zoomTo(scaleSV, 3.2);
    const image = container.querySelector('img');
    expect(image?.getAttribute('data-uri')).toBe(photo.uri);
    expect(image?.getAttribute('data-cache-key')).toBe(photo.cacheKey);
    // `fill` matches the base's box; on iOS only `allowDownscaling={false}`
    // stops expo-image resizing it to the view's un-zoomed pixel size.
    expect(imageRenders.at(-1)?.contentFit).toBe('fill');
    expect(imageRenders.at(-1)?.allowDownscaling).toBe(false);
  });

  // expo-image's Android safety cap only runs with downscaling allowed. With
  // `fill` it shrinks nothing under the 100 MiB Android will draw, and without
  // it an oversized bitmap throws "Canvas: trying to draw too large bitmap".
  it('leaves the Android bitmap-size safety cap on', () => {
    const { scaleSV } = setup();
    platform.OS = 'android';
    zoomTo(scaleSV, 4);
    expect(imageRenders.at(-1)?.contentFit).toBe('fill');
    expect(imageRenders.at(-1)?.allowDownscaling).toBe(true);
  });

  // Zooming back out must not unload and re-decode it on the next zoom in.
  it('keeps the full photo once it has been fetched', () => {
    const { container, scaleSV } = setup();
    zoomTo(scaleSV, 4);
    zoomTo(scaleSV, 1);
    zoomTo(scaleSV, 5);
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('reports a photo that will not load', () => {
    const { scaleSV, onError } = setup();
    zoomTo(scaleSV, 4);
    act(() => imageRenders.at(-1)?.onError?.());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

// The editor keeps the downloaded copy (`ensureSprayFullPhotoCached`), so a
// second visit decodes a file instead of downloading several megabytes again.
describe('FullResolutionPhotoLayer with a kept file', () => {
  /** A loader the test settles by hand. */
  function deferredLoader() {
    const settle = { resolve: (_path: string | null) => {}, reject: () => {} };
    const loadFromDisk = vi.fn(
      () =>
        new Promise<string | null>((resolve, reject) => {
          settle.resolve = resolve;
          settle.reject = () => reject(new Error('disk'));
        }),
    );
    return { loadFromDisk, settle };
  }

  it('asks for the file only once the zoom passes the switch zoom', () => {
    const { loadFromDisk } = deferredLoader();
    const { scaleSV } = setup({ ...photo, loadFromDisk });
    zoomTo(scaleSV, 2);
    expect(loadFromDisk).not.toHaveBeenCalled();
    zoomTo(scaleSV, 4);
    expect(loadFromDisk).toHaveBeenCalledTimes(1);
  });

  it('draws nothing while the file is fetched, then the file', async () => {
    const { loadFromDisk, settle } = deferredLoader();
    const { container, scaleSV } = setup({ ...photo, loadFromDisk });
    zoomTo(scaleSV, 4);
    // The base shows through, as it does while a URL loads.
    expect(container.querySelector('img')).toBeNull();
    await act(async () => settle.resolve('/cache/spray-walls/4200-full-x.jpg'));
    const image = container.querySelector('img');
    expect(image?.getAttribute('data-uri')).toBe('file:///cache/spray-walls/4200-full-x.jpg');
    expect(image?.getAttribute('data-cache-key')).toBe(photo.cacheKey);
  });

  it.each(['null', 'reject'] as const)('loads the URL when the file could not be kept (%s)', async (outcome) => {
    const { loadFromDisk, settle } = deferredLoader();
    const { container, scaleSV } = setup({ ...photo, loadFromDisk });
    zoomTo(scaleSV, 4);
    await act(async () => (outcome === 'null' ? settle.resolve(null) : settle.reject()));
    expect(container.querySelector('img')?.getAttribute('data-uri')).toBe(photo.uri);
  });

  // A kept file that will not decode costs one download, not a sharp photo.
  it('falls back to the URL when the kept file will not load, and only then reports', async () => {
    const { loadFromDisk, settle } = deferredLoader();
    const discardFromDisk = vi.fn();
    const { container, scaleSV, onError } = setup({ ...photo, loadFromDisk, discardFromDisk });
    zoomTo(scaleSV, 4);
    await act(async () => settle.resolve('/cache/spray-walls/4200-full-x.jpg'));
    act(() => imageRenders.at(-1)?.onError?.());
    expect(onError).not.toHaveBeenCalled();
    // The bad file goes, so the next visit downloads a good one.
    expect(discardFromDisk).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('data-uri')).toBe(photo.uri);
    act(() => imageRenders.at(-1)?.onError?.());
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
