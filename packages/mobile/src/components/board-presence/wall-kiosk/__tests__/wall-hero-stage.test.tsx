// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode };

// PixelRatio.get() is the display density the overlay is rasterized against; pin
// it so the render-width assertions are about the component, not the host.
const pixelRatio = vi.hoisted(() => ({ value: 2 }));
const queueState = vi.hoisted(() => ({
  queue: [] as { uuid: string; climb: { uuid: string; mirrored?: boolean } }[],
  currentClimbQueueItem: null,
}));
vi.mock('../../../../providers/queue-provider', () => ({ useQueueData: () => queueState }));

vi.mock('react-native', () => ({
  View: ({ children }: ViewMockProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  PixelRatio: { get: () => pixelRatio.value },
}));

// Capture what the kiosk hands the board renderer. The real BoardImageNative pulls
// in the Rust render pipeline and the bundled-asset cache — neither is under test
// here; the render sizing it is asked for is.
const boardImageProps = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../../../BoardImageNative', () => ({
  BoardImageNative: (props: Record<string, unknown>) => {
    boardImageProps.calls.push(props);
    return createElement('div', { 'data-testid': 'board-image' });
  },
}));

vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#000' } }),
}));
import { WallHeroStage } from '../WallHeroStage';

const boardConfig = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
} as unknown as Parameters<typeof WallHeroStage>[0]['boardConfig'];

function renderStage(
  artWidth: number,
  climb: Parameters<typeof WallHeroStage>[0]['climb'] = null,
  isPreviewing = false,
): Record<string, unknown> {
  boardImageProps.calls.length = 0;
  render(
    createElement(WallHeroStage, {
      climb,
      isPreviewing,
      boardConfig,
      boardWidth: 1080,
      boardHeight: 1170,
      artWidth,
      artHeight: artWidth,
    }),
  );
  const captured = boardImageProps.calls.at(-1);
  if (!captured) throw new Error('BoardImageNative did not render');
  return captured;
}

describe('WallHeroStage board-art sizing', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    pixelRatio.value = 2;
    queueState.queue = [];
  });

  it.each(['0', '1'])('renders the supplied climb with capture flag %s', (captureFlag) => {
    const climb = { climbUuid: 'real-climb', frames: 'p1r12', angle: 40, sentAt: '2026-10-13T12:00:00Z', seq: 1 };
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', captureFlag);
    expect(renderStage(600, climb)).toMatchObject({ frames: climb.frames, boardName: boardConfig.boardName });
    expect(renderStage(600, climb).paintedTestID).toBeUndefined();
  });

  it('keeps the board photo full-resolution', () => {
    // Passing renderWidth flips useNativeClimbRender's background default to the
    // 416px `thumb` variant. The photo is one shared decode across every climb on
    // the wall, and this is the largest surface in the app — it must stay `full`.
    expect(renderStage(600).backgroundVariant).toBe('full');
  });

  it('sizes the holds overlay to the drawn surface rather than the board default', () => {
    // Omitting renderWidth rasterizes at the board's native width for every climb.
    // The assertion is the behavioural property — the request tracks the surface —
    // not a re-computation of the component's own arithmetic.
    const narrow = renderStage(400).renderWidth;
    const wide = renderStage(800).renderWidth;
    expect(typeof narrow).toBe('number');
    expect(wide as number).toBeGreaterThan(narrow as number);
  });

  it('scales the request by display density', () => {
    const atOneX = renderStage(500).renderWidth;
    pixelRatio.value = 3;
    const atThreeX = renderStage(500).renderWidth;
    expect(atThreeX as number).toBeGreaterThan(atOneX as number);
  });

  it('falls back to the native-width render before the surface is measured', () => {
    // A zero width would ask the Rust renderer for a 0px output. Undefined means
    // "native width" — the pre-existing behaviour — so an unmeasured frame renders
    // the board instead of nothing.
    expect(renderStage(0).renderWidth).toBeUndefined();
  });

  it('previews the target climb orientation that Light this will write', () => {
    const climb = {
      climbUuid: 'target',
      source: 'aurora' as const,
      angle: null,
      frames: 'p1r12',
      sentAt: '2026-11-24T12:00:00Z',
      seq: 1,
    };
    queueState.queue = [{ uuid: 'one', climb: { uuid: 'target', mirrored: true } }];
    expect(renderStage(600, climb).mirrored).toBe(false);
    expect(renderStage(600, climb, true).mirrored).toBe(true);
    expect(renderStage(600, { ...climb, mirrored: false }, true).mirrored).toBe(false);
    queueState.queue = [...queueState.queue, { uuid: 'two', climb: { uuid: 'target', mirrored: false } }];
    expect(renderStage(600, climb, true).mirrored).toBe(false);
    expect(climb).not.toHaveProperty('mirrored');
  });

  it('renders a native mirrored confirmation using its recorded orientation', () => {
    const climb = {
      climbUuid: 'target',
      source: 'boardsesh' as const,
      angle: 40,
      mirrored: true,
      frames: 'p1r12',
      sentAt: '2026-11-24T12:00:00Z',
      seq: 1,
    };
    expect(renderStage(600, climb).mirrored).toBe(true);
  });
});
