// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement, forwardRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MapProps = {
  onMapLoaded?: () => void;
  onMarkerClick?: (event: { id: string }) => void;
  onCameraMove?: (event: { coordinates: { latitude: number; longitude: number } }) => void;
};

const nativeState = vi.hoisted(() => ({
  platform: 'android',
  available: true,
  throwOnRender: false,
  props: null as MapProps | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return nativeState.platform;
    },
  },
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('../native-maps', () => {
  const MapView = forwardRef<unknown, MapProps>((props, _ref) => {
    if (nativeState.throwOnRender) throw new Error('Native view missing');
    nativeState.props = props;
    return createElement('div', { 'data-testid': 'native-map' });
  });
  return {
    get nativeMaps() {
      return nativeState.available ? { AppleMaps: { View: MapView }, GoogleMaps: { View: MapView } } : null;
    },
  };
});

import { GymMap } from '../GymMap';

const center = { latitude: 40.76, longitude: -111.89 };

beforeEach(() => {
  vi.useFakeTimers();
  nativeState.platform = 'android';
  nativeState.available = true;
  nativeState.throwOnRender = false;
  nativeState.props = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('gym map availability', () => {
  it('reports a mounted Android map that never loads after 15 seconds', () => {
    const onUnavailable = vi.fn();
    const { getByTestId } = render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} />);

    act(() => {
      vi.advanceTimersByTime(14_999);
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(getByTestId('native-map')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('cancels the timeout when Google Maps finishes loading', () => {
    const onUnavailable = vi.fn();
    const onReady = vi.fn();
    render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} onMapReady={onReady} />);

    act(() => nativeState.props?.onMapLoaded?.());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('recovers from a late load and keeps marker taps and panning working', () => {
    const onUnavailable = vi.fn();
    const onReady = vi.fn();
    const onMarkerPress = vi.fn();
    const onRegionChange = vi.fn();
    render(
      <GymMap
        center={center}
        markers={[]}
        onMapUnavailable={onUnavailable}
        onMapReady={onReady}
        onMarkerPress={onMarkerPress}
        onRegionChange={onRegionChange}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(onUnavailable).toHaveBeenCalledOnce();
    act(() => nativeState.props?.onMapLoaded?.());
    expect(onReady).toHaveBeenCalledOnce();
    act(() => nativeState.props?.onMapLoaded?.());
    expect(onReady).toHaveBeenCalledOnce();
    act(() => {
      nativeState.props?.onMarkerClick?.({ id: 'gym-1' });
      nativeState.props?.onCameraMove?.({ coordinates: center });
    });
    expect(onMarkerPress).toHaveBeenCalledWith('gym-1');
    expect(onRegionChange).toHaveBeenCalledWith(center);
  });

  it('keeps the original deadline across parent renders and uses the latest callback', () => {
    const originalUnavailable = vi.fn();
    const latestUnavailable = vi.fn();
    const { rerender } = render(<GymMap center={center} markers={[]} onMapUnavailable={originalUnavailable} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    rerender(<GymMap center={center} markers={[]} onMapUnavailable={latestUnavailable} />);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(originalUnavailable).not.toHaveBeenCalled();
    expect(latestUnavailable).toHaveBeenCalledOnce();
  });

  it('cleans up the deadline when leaving the finder', () => {
    const onUnavailable = vi.fn();
    const { unmount } = render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} />);
    unmount();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for an unsupported map-loaded event on iOS', () => {
    nativeState.platform = 'ios';
    const onUnavailable = vi.fn();
    render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} />);
    expect(nativeState.props?.onMapLoaded).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a missing native module immediately', () => {
    nativeState.available = false;
    const onUnavailable = vi.fn();
    const { queryByTestId } = render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} />);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(queryByTestId('native-map')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('catches a native mount failure without leaving a timer behind', () => {
    nativeState.throwOnRender = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onUnavailable = vi.fn();
    const { queryByTestId } = render(<GymMap center={center} markers={[]} onMapUnavailable={onUnavailable} />);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(queryByTestId('native-map')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
