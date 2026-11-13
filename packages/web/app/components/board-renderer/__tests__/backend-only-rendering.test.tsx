// @vitest-environment jsdom

import React, { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails, Climb } from '@/app/lib/types';
import ClimbThumbnail from '@/app/components/climb-card/climb-thumbnail';
import BoardSlot from '@/app/components/kiosk/board-slot/board-slot';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import { buildBoardRenderUrl } from '../util';

const presence = vi.hoisted(() => ({
  current: null as { currentClimb: { frames: string } | null; history: { frames: string }[] } | null,
}));
vi.mock('@/app/components/kiosk/presence/use-kiosk-board-presence', () => ({
  useKioskBoardPresence: () => presence.current,
}));
vi.mock('@/app/components/kiosk/board-slot/board-identity', () => ({ default: () => null }));
vi.mock('@/app/components/kiosk/board-slot/board-install-qr', () => ({ default: () => null }));

const boardDetails: BoardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  images_to_holds: { 'product_sizes_layouts_sets/36-1.png': [] },
  holdsData: [],
  edge_left: 0,
  edge_right: 144,
  edge_bottom: 0,
  edge_top: 180,
  boardWidth: 1080,
  boardHeight: 1350,
};
const climb = {
  uuid: 'climb-one',
  frames: 'p1r12,p2r13',
  mirrored: true,
} as Climb;

const workerConstructor = vi.fn(function () {
  throw new Error('Next.js board images must not create rendering workers');
});

beforeEach(() => {
  presence.current = null;
  workerConstructor.mockClear();
  vi.stubEnv('NEXT_PUBLIC_WS_URL', 'wss://ws.boardsesh.com/graphql');
  vi.stubGlobal('Worker', workerConstructor);
  vi.stubGlobal('OffscreenCanvas', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function overlayUrl(container: HTMLElement): URL {
  const image = container.querySelector<HTMLImageElement>('img[src*="/render/board?"]');
  expect(image).not.toBeNull();
  return new URL(image!.src);
}

describe('backend-only board images', () => {
  it('keeps the SSR image and versioned backend URL after hydration', async () => {
    const thumbnail = <ClimbThumbnail boardDetails={boardDetails} currentClimb={climb} pathname="/b/main/40/list" />;
    const container = document.createElement('div');
    container.innerHTML = renderToString(thumbnail);
    document.body.append(container);
    const initialImage = container.querySelector('img');
    const initialUrl = overlayUrl(container);
    const onRecoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, thumbnail, { onRecoverableError });
      });
      expect(container.querySelector('img')).toBe(initialImage);
      expect(overlayUrl(container).href).toBe(initialUrl.href);
      expect(initialUrl.origin).toBe('https://ws.boardsesh.com');
      expect(initialUrl.searchParams.get('frames')).toBe('p1r42p2r43');
      expect(initialUrl.searchParams.get('thumbnail')).toBe('1');
      expect(initialUrl.searchParams.get('v')).toBe(BOARD_RENDER_VERSION);
      expect(initialImage?.parentElement?.style.transform).toBe('scaleX(-1)');
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(workerConstructor).not.toHaveBeenCalled();
      expect(container.querySelector('canvas')).toBeNull();
    } finally {
      await act(async () => root?.unmount());
      container.remove();
    }
  });

  it('updates kiosk backend image URLs for live climbs and clear-wall events', () => {
    const bareImageUrl = buildBoardRenderUrl(boardDetails, '', { includeBackground: true });
    const slot = (
      <BoardSlot
        boardId={1}
        boardName="Main Kilter"
        angle={40}
        boardDetails={boardDetails}
        initialClimb={null}
        initialClimbImageUrl={null}
        bareBoardImageUrl={bareImageUrl}
        slug="main-kilter"
        showInstallQr={false}
      />
    );
    const { container, rerender } = render(slot);
    const seededImage = container.querySelector('img');
    expect(seededImage?.getAttribute('src')).toBe(bareImageUrl);

    presence.current = { currentClimb: { frames: 'p1r12,p2r13' }, history: [] };
    rerender(React.cloneElement(slot));
    const firstUrl = overlayUrl(container);
    expect(firstUrl.origin).toBe('https://ws.boardsesh.com');
    expect(firstUrl.searchParams.get('frames')).toBe('p1r42p2r43');
    expect(firstUrl.searchParams.get('thumbnail')).toBeNull();
    expect(firstUrl.searchParams.get('v')).toBe(BOARD_RENDER_VERSION);
    expect(container.querySelector('img')?.className).toContain('raster');
    expect(firstUrl.searchParams.get('include_background')).toBe('1');

    presence.current = { currentClimb: { frames: 'p3r15' }, history: [{ frames: 'p1r12,p2r13' }] };
    rerender(React.cloneElement(slot));
    expect(overlayUrl(container).searchParams.get('frames')).toBe('p3r15');
    expect(overlayUrl(container).href).not.toBe(firstUrl.href);

    presence.current = { currentClimb: null, history: [{ frames: 'p3r15' }] };
    rerender(React.cloneElement(slot));
    expect(overlayUrl(container).searchParams.get('frames')).toBe('');
    expect(overlayUrl(container).searchParams.get('include_background')).toBe('1');
    expect(overlayUrl(container).href).toBe(bareImageUrl);
    expect(container.querySelector('img')).toBe(seededImage);
    expect(container.querySelector('canvas')).toBeNull();
    expect(workerConstructor).not.toHaveBeenCalled();
  });
});
