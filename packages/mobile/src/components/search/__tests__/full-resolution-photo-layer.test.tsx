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

vi.mock('react-native', () => ({
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

function setup() {
  reaction.last = null;
  imageRenders.length = 0;
  const scaleSV = { value: 1 };
  const onError = vi.fn();
  const view = render(
    createElement(FullResolutionPhotoLayer, {
      photo,
      scaleSV: scaleSV as unknown as Parameters<typeof FullResolutionPhotoLayer>[0]['scaleSV'],
      onError,
    }),
  );
  // The initial run, as Reanimated makes on mount.
  zoomTo(scaleSV, 1);
  return { ...view, scaleSV, onError };
}

afterEach(() => cleanup());

describe('FullResolutionPhotoLayer', () => {
  // A 4096 px photo is ~48 MB decoded; most visits never zoom that far.
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
