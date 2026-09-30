import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act, screen } from '@testing-library/react';
import { useAutoplayVideo } from '../use-autoplay-video';

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;

let observerCallback: ObserverCallback | null = null;
let observerOptions: IntersectionObserverInit | undefined;
const playSpy = vi.fn<() => Promise<void>>();
const pauseSpy = vi.fn();

function mockReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function Harness({ rootMargin }: { rootMargin?: string }) {
  const { videoRef, showsControls } = useAutoplayVideo({ rootMargin });
  return <video ref={videoRef} data-testid="video" controls={showsControls} muted />;
}

function scrollIntoView(isIntersecting: boolean) {
  act(() => {
    observerCallback?.([{ isIntersecting }]);
  });
}

describe('useAutoplayVideo', () => {
  beforeEach(() => {
    observerCallback = null;
    observerOptions = undefined;
    playSpy.mockReset().mockResolvedValue(undefined);
    pauseSpy.mockReset();
    HTMLMediaElement.prototype.play = playSpy;
    HTMLMediaElement.prototype.pause = pauseSpy;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
          observerCallback = callback;
          observerOptions = options;
        }
        observe() {}
        disconnect() {}
      },
    );
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays while in view and pauses when it scrolls away', () => {
    render(<Harness />);
    expect(playSpy).not.toHaveBeenCalled();

    scrollIntoView(true);
    expect(playSpy).toHaveBeenCalledTimes(1);

    pauseSpy.mockClear();
    scrollIntoView(false);
    expect(pauseSpy).toHaveBeenCalled();
  });

  it('passes the rootMargin option to the observer', () => {
    render(<Harness rootMargin="50px 0px" />);
    expect(observerOptions?.rootMargin).toBe('50px 0px');
  });

  it('shows controls and never autoplays for a reduced-motion reader', () => {
    mockReducedMotion(true);
    render(<Harness />);
    scrollIntoView(true);

    expect(playSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(true);
  });

  it('shows controls when the browser refuses to play', async () => {
    playSpy.mockRejectedValue(new DOMException('blocked', 'NotAllowedError'));
    render(<Harness />);
    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(false);

    scrollIntoView(true);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(true);
  });
});
