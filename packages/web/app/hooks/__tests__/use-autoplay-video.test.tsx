import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act, screen, fireEvent } from '@testing-library/react';
import { useAutoplayVideo } from '../use-autoplay-video';

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;

let observerCallback: ObserverCallback | null = null;
let observerOptions: IntersectionObserverInit | undefined;
let reducedMotionListener: (() => void) | null = null;
let reducedMotionMatches = false;
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;

function stubReducedMotion(matches: boolean) {
  reducedMotionMatches = matches;
  reducedMotionListener = null;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return reducedMotionMatches;
      },
      addEventListener: (_event: string, listener: () => void) => {
        reducedMotionListener = listener;
      },
      removeEventListener: vi.fn(),
    })),
  );
}

function Harness({ rootMargin, threshold, enabled }: { rootMargin?: string; threshold?: number; enabled?: boolean }) {
  const { videoRef, showsControls, userPaused, isShowingVideo, toggleUserPaused } = useAutoplayVideo({
    rootMargin,
    threshold,
    enabled,
  });
  return (
    <div>
      <video ref={videoRef} data-testid="video" controls={showsControls} data-showing={isShowingVideo} muted />
      <button onClick={toggleUserPaused}>{userPaused ? 'resume' : 'pause'}</button>
    </div>
  );
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
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
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
    stubReducedMotion(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it('leaves the video alone while disabled and plays once enabled', () => {
    const { rerender } = render(<Harness enabled={false} />);
    scrollIntoView(true);
    expect(playSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();

    rerender(<Harness enabled />);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the default rootMargin unless one is passed', () => {
    render(<Harness />);
    expect(observerOptions?.rootMargin).toBe('200px 0px');
  });

  it('passes rootMargin and threshold to the observer', () => {
    render(<Harness rootMargin="0px" threshold={0.1} />);
    expect(observerOptions).toEqual({ rootMargin: '0px', threshold: 0.1 });
  });

  it('plays straight away when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Harness />);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('shows controls and never autoplays for a reduced-motion reader', () => {
    stubReducedMotion(true);
    render(<Harness />);
    scrollIntoView(true);

    expect(playSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(true);
  });

  it('reacts when the reduced-motion setting changes', () => {
    render(<Harness />);
    scrollIntoView(true);
    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(false);

    reducedMotionMatches = true;
    act(() => {
      reducedMotionListener?.();
    });

    expect(screen.getByTestId('video').hasAttribute('controls')).toBe(true);
    expect(pauseSpy).toHaveBeenCalled();
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

  it('keeps a video the reader paused paused when it scrolls back into view', () => {
    render(<Harness />);
    scrollIntoView(true);
    expect(playSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('pause'));
    expect(pauseSpy).toHaveBeenCalled();

    scrollIntoView(false);
    scrollIntoView(true);
    expect(playSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('resume'));
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it('reports playing once the video fires its playing event', () => {
    render(<Harness />);
    expect(screen.getByTestId('video').getAttribute('data-showing')).toBe('false');

    fireEvent(screen.getByTestId('video'), new Event('playing'));
    expect(screen.getByTestId('video').getAttribute('data-showing')).toBe('true');
  });

  it.each(['emptied', 'error'])('reveals the poster again after %s', (eventName) => {
    render(<Harness />);
    fireEvent(screen.getByTestId('video'), new Event('playing'));
    fireEvent(screen.getByTestId('video'), new Event(eventName));
    expect(screen.getByTestId('video').getAttribute('data-showing')).toBe('false');
  });

  it('keeps showing the paused frame after pause', () => {
    render(<Harness />);
    fireEvent(screen.getByTestId('video'), new Event('playing'));
    fireEvent(screen.getByTestId('video'), new Event('pause'));
    expect(screen.getByTestId('video').getAttribute('data-showing')).toBe('true');
  });

  it('keeps reporting playing after ended, since the video loops', () => {
    render(<Harness />);
    fireEvent(screen.getByTestId('video'), new Event('playing'));
    fireEvent(screen.getByTestId('video'), new Event('ended'));
    expect(screen.getByTestId('video').getAttribute('data-showing')).toBe('true');
  });
});
