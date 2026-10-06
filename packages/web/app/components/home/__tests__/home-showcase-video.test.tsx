import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act, screen, fireEvent } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => tFromCatalog('marketing', key), i18n: { language: 'en-US' } }),
}));

const mockTrack = vi.fn();
vi.mock('@/app/lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }));

import HomeShowcaseVideo from '../home-showcase-video';

type ObserverCallback = (entries: { isIntersecting: boolean }[]) => void;

let observerCallback: ObserverCallback | null = null;
let idleCallbacks: (() => void)[] = [];
let reducedMotion = false;
let playSpy: ReturnType<typeof vi.spyOn>;
let pauseSpy: ReturnType<typeof vi.spyOn>;
let canPlayTypeSpy: ReturnType<typeof vi.spyOn>;

function getVideo(): HTMLVideoElement {
  const video = document.querySelector('video');
  if (!video) throw new Error('no video rendered');
  return video;
}

function runIdleCallbacks() {
  act(() => {
    for (const callback of idleCallbacks.splice(0)) callback();
  });
}

function scrollIntoView(isIntersecting: boolean) {
  act(() => {
    observerCallback?.([{ isIntersecting }]);
  });
}

function playAt(video: HTMLVideoElement, currentTime: number) {
  Object.defineProperty(video, 'duration', { value: 40, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: currentTime, configurable: true, writable: true });
  fireEvent(video, new Event('timeupdate'));
}

describe('HomeShowcaseVideo', () => {
  beforeEach(() => {
    observerCallback = null;
    idleCallbacks = [];
    reducedMotion = false;
    mockTrack.mockReset();
    playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    canPlayTypeSpy = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: ObserverCallback) {
          observerCallback = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({
      matches: reducedMotion,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => idleCallbacks.push(callback));
    vi.stubGlobal('cancelIdleCallback', () => undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(window.navigator, 'connection');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a sized, high-priority poster and no video source before the page is idle', () => {
    render(<HomeShowcaseVideo />);
    const poster = document.querySelector('img');
    expect(poster?.getAttribute('src')).toBe('/images/home/showcase-hero-9x16.webp');
    expect(poster?.getAttribute('width')).toBe('720');
    expect(poster?.getAttribute('height')).toBe('1280');
    expect(poster?.getAttribute('fetchpriority')).toBe('high');
    expect(poster?.hasAttribute('decoding')).toBe(false);
    expect(getVideo().getAttribute('src')).toBeNull();
    expect(getVideo().getAttribute('preload')).toBe('none');
  });

  it('keeps the poster visible and the video hidden until it is playing', () => {
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    scrollIntoView(true);
    const poster = document.querySelector('img');
    expect(poster).toBeTruthy();
    expect(poster?.hasAttribute('hidden')).toBe(false);
    expect(getVideo().hasAttribute('poster')).toBe(false);
    expect(getVideo().getAttribute('data-active')).toBe('false');

    fireEvent(getVideo(), new Event('playing'));
    expect(getVideo().getAttribute('data-active')).toBe('true');
  });

  it('renders the pause toggle with the scrim-backed toggle style', () => {
    render(<HomeShowcaseVideo />);
    const toggle = screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') });
    expect(toggle.className).toMatch(/toggle/);
  });

  it('lists all eight scene headlines in a hidden caption', () => {
    render(<HomeShowcaseVideo />);
    const items = document.querySelectorAll('figcaption li');
    expect(items).toHaveLength(8);
    expect(items[5].textContent).toBe(tFromCatalog('marketing', 'home.showcase.scenes.island'));
  });

  it('loads the webm after window load plus idle, then plays once in view', () => {
    render(<HomeShowcaseVideo />);
    expect(getVideo().getAttribute('src')).toBeNull();

    runIdleCallbacks();
    expect(getVideo().getAttribute('src')).toBe('/videos/home/showcase-9x16-lite.webm');
    expect(getVideo().preload).toBe('auto');
    expect(playSpy).not.toHaveBeenCalled();

    scrollIntoView(true);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the mp4 when webm is not playable', () => {
    canPlayTypeSpy.mockReturnValue('');
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    expect(getVideo().getAttribute('src')).toBe('/videos/home/showcase-9x16-lite.mp4');
  });

  it('keeps the poster and shows a play button when the reader saves data', () => {
    Object.defineProperty(window.navigator, 'connection', { value: { saveData: true }, configurable: true });
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    scrollIntoView(true);

    expect(getVideo().getAttribute('src')).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') }));
    expect(getVideo().getAttribute('src')).toBe('/videos/home/showcase-9x16-lite.webm');
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('does not autoplay for reduced motion but plays on request', () => {
    reducedMotion = true;
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    scrollIntoView(true);
    expect(getVideo().getAttribute('src')).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') }));
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes through the hook with exactly one play() call per resume', () => {
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    scrollIntoView(true);
    expect(playSpy).toHaveBeenCalledTimes(1);

    const setPaused = (value: boolean) => Object.defineProperty(getVideo(), 'paused', { value, configurable: true });
    fireEvent(getVideo(), new Event('play'));
    setPaused(false);

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.pause') }));
    expect(pauseSpy).toHaveBeenCalled();
    setPaused(true);
    fireEvent(getVideo(), new Event('pause'));
    expect(playSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') }));
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it('treats refused autoplay like data saver: poster stays, big play button, one play() per click', async () => {
    playSpy.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    scrollIntoView(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(playSpy).toHaveBeenCalledTimes(1);

    expect(getVideo().hasAttribute('controls')).toBe(false);
    expect(getVideo().getAttribute('data-active')).toBe('false');
    expect(document.querySelector('img')).toBeTruthy();
    const playButton = screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') });
    expect(playButton.className).toMatch(/toggleCentered/);

    fireEvent.click(playButton);
    expect(playSpy).toHaveBeenCalledTimes(2);
  });

  it('releases the deferred load when the reader presses play before the page is idle', () => {
    render(<HomeShowcaseVideo />);
    scrollIntoView(true);
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') }));
    expect(getVideo().getAttribute('src')).toBe('/videos/home/showcase-9x16-lite.webm');
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it('reports each quartile once, flagged as autoplayed', () => {
    render(<HomeShowcaseVideo />);
    runIdleCallbacks();
    const video = getVideo();

    playAt(video, 11);
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenLastCalledWith('Showcase Video Progress', {
      quartile: 25,
      placement: 'hero',
      cut: '9x16-lite',
      autoplayed: true,
    });

    playAt(video, 11.5);
    expect(mockTrack).toHaveBeenCalledTimes(1);

    playAt(video, 39.5);
    const quartiles = mockTrack.mock.calls.map(([, properties]) => (properties as { quartile: number }).quartile);
    expect(quartiles).toEqual([25, 50, 75, 100]);

    playAt(video, 12);
    expect(mockTrack).toHaveBeenCalledTimes(4);
  });

  it('flags progress as not autoplayed when the reader pressed play', () => {
    reducedMotion = true;
    render(<HomeShowcaseVideo />);
    fireEvent.click(screen.getByRole('button', { name: tFromCatalog('marketing', 'home.showcase.play') }));
    playAt(getVideo(), 11);
    expect(mockTrack).toHaveBeenCalledWith(
      'Showcase Video Progress',
      expect.objectContaining({ quartile: 25, autoplayed: false }),
    );
  });
});
