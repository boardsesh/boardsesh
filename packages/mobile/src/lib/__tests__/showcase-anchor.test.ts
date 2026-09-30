// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { LayoutChangeEvent } from 'react-native';

vi.mock('react-native', () => ({ View: 'View' }));

type ShowcaseAnchorModule = typeof import('../showcase-anchor');

async function loadShowcaseAnchor(screenshotMode: boolean): Promise<ShowcaseAnchorModule> {
  vi.resetModules();
  if (screenshotMode) vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
  return import('../showcase-anchor');
}

const CONTRACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../scripts/lib/showcase-video/contract.ts',
);

function layoutEvent(currentTarget: unknown = null): LayoutChangeEvent {
  return {
    currentTarget,
    nativeEvent: { layout: { x: 0, y: 0, width: 0, height: 0 } },
  } as unknown as LayoutChangeEvent;
}

/** A host view whose on-screen rect the test moves around. */
function fakeView(rect: { x: number; y: number; width: number; height: number }) {
  return {
    rect,
    measureInWindow: vi.fn((callback: (x: number, y: number, width: number, height: number) => void) => {
      callback(rect.x, rect.y, rect.width, rect.height);
    }),
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  logSpy.mockRestore();
});

describe('showcase anchor contract', () => {
  it('uses the same anchor names and log prefix as the recorder contract', async () => {
    const contract = readFileSync(CONTRACT_PATH, 'utf8');
    const namesBlock = contract.match(/export const SHOWCASE_ANCHOR_NAMES = \[([^\]]*)\] as const;/);
    const prefix = contract.match(/export const SHOWCASE_ANCHOR_LOG_PREFIX = '([^']*)';/);
    expect(namesBlock, 'SHOWCASE_ANCHOR_NAMES not found in the contract').not.toBeNull();
    expect(prefix, 'SHOWCASE_ANCHOR_LOG_PREFIX not found in the contract').not.toBeNull();
    const contractNames = [...(namesBlock?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);

    const { SHOWCASE_ANCHOR_NAMES, SHOWCASE_ANCHOR_LOG_PREFIX } = await loadShowcaseAnchor(false);
    expect([...SHOWCASE_ANCHOR_NAMES]).toEqual(contractNames);
    expect(SHOWCASE_ANCHOR_LOG_PREFIX).toBe(prefix?.[1]);
  });

  it('formats the line the recorder parses, and nothing for an unlaid rect', async () => {
    const { formatShowcaseAnchorLine } = await loadShowcaseAnchor(false);
    expect(formatShowcaseAnchorLine('wall-pill', 24, 118.333, 132, 32)).toBe(
      '[showcase-anchor] {"name":"wall-pill","x":24,"y":118.3,"width":132,"height":32}',
    );
    expect(formatShowcaseAnchorLine('wall-pill', 0, 0, 0, 32)).toBeNull();
    expect(formatShowcaseAnchorLine('wall-pill', Number.NaN, 0, 10, 10)).toBeNull();
  });
});

describe('useShowcaseAnchor outside screenshot mode', () => {
  it('returns one frozen no-op without calling any hook', async () => {
    const { useShowcaseAnchor } = await loadShowcaseAnchor(false);
    // Called bare, outside a component: it would throw if it used a hook.
    const first = useShowcaseAnchor('wall-pill');
    const second = useShowcaseAnchor('invite-qr', true);
    expect(first).toEqual({ ref: undefined, onLayout: undefined });
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('renders ShowcaseAnchorView children untouched', async () => {
    const { ShowcaseAnchorView } = await loadShowcaseAnchor(false);
    const child = 'row';
    expect(ShowcaseAnchorView({ name: 'play-next', children: child })).toBe(child);
  });
});

describe('useShowcaseAnchor in screenshot mode', () => {
  it('logs the measured rect on layout, re-measures once the sheet settles, and skips repeats', async () => {
    vi.useFakeTimers();
    const { useShowcaseAnchor, SHOWCASE_ANCHOR_SETTLE_DELAYS_MS } = await loadShowcaseAnchor(true);
    const { result } = renderHook(() => useShowcaseAnchor('invite-qr'));
    const view = fakeView({ x: 100, y: 900, width: 200, height: 200 });

    result.current.ref?.(view);
    result.current.onLayout?.(layoutEvent());
    expect(logSpy).toHaveBeenLastCalledWith(
      '[showcase-anchor] {"name":"invite-qr","x":100,"y":900,"width":200,"height":200}',
    );

    // The sheet springs up with a transform: no new layout, only the timers see it.
    view.rect.y = 420;
    vi.advanceTimersByTime(SHOWCASE_ANCHOR_SETTLE_DELAYS_MS[0]);
    expect(logSpy).toHaveBeenLastCalledWith(
      '[showcase-anchor] {"name":"invite-qr","x":100,"y":420,"width":200,"height":200}',
    );
    vi.advanceTimersByTime(SHOWCASE_ANCHOR_SETTLE_DELAYS_MS[1]);
    expect(view.measureInWindow).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it('falls back to the layout event target when no ref is attached', async () => {
    const { useShowcaseAnchor } = await loadShowcaseAnchor(true);
    const { result } = renderHook(() => useShowcaseAnchor('profile-board-filter'));
    result.current.onLayout?.(layoutEvent(fakeView({ x: 300, y: 80, width: 90, height: 48 })));
    expect(logSpy).toHaveBeenLastCalledWith(
      '[showcase-anchor] {"name":"profile-board-filter","x":300,"y":80,"width":90,"height":48}',
    );
  });

  it('keeps identity across renders and hands back no-op props when disabled', async () => {
    const { useShowcaseAnchor } = await loadShowcaseAnchor(true);
    const { result, rerender } = renderHook(({ enabled }) => useShowcaseAnchor('queue-row-avatar', enabled), {
      initialProps: { enabled: true },
    });
    const enabledProps = result.current;
    rerender({ enabled: true });
    expect(result.current).toBe(enabledProps);
    expect(enabledProps.onLayout).toBeTypeOf('function');

    rerender({ enabled: false });
    expect(result.current).toEqual({ ref: undefined, onLayout: undefined });
  });

  it('stops re-measuring once the view unmounts', async () => {
    vi.useFakeTimers();
    const { useShowcaseAnchor } = await loadShowcaseAnchor(true);
    const { result, unmount } = renderHook(() => useShowcaseAnchor('wall-pill'));
    const view = fakeView({ x: 16, y: 60, width: 32, height: 32 });
    result.current.ref?.(view);
    result.current.onLayout?.(layoutEvent());
    unmount();
    vi.runAllTimers();
    expect(view.measureInWindow).toHaveBeenCalledTimes(1);
  });
});
