import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { RenderBoardConfig } from '@boardsesh/shared-schema';
import AscentThumbnail from '../ascent-thumbnail';

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// The thumbnail itself is irrelevant here — only the href it wraps is.
vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));
vi.mock('../ascents-feed.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

/**
 * Kilter layout 1 carries two "12 x 12" squares — id 10 ("with kickboard") and
 * id 27 ("without kickboard") — that both *name*-slug to `12x12-square`. The
 * feed's `renderBoard` prop is the board the backend resolved for this ascent
 * (the one it was logged on), so the thumbnail holds the numeric ids and must
 * address the exact wall. Before #4417 it slugged from names and pointed a
 * size-27 climber's own thumbnail at size 10's board.
 *
 * Same shape as `board-page/__tests__/header-create-url.test.tsx`, which locks
 * the equivalent invariant for the header's Create button.
 */
function thumbnailHref(renderBoard: RenderBoardConfig) {
  render(
    <AscentThumbnail
      boardType="kilter"
      layoutId={1}
      angle={40}
      climbUuid="ABC123"
      climbName="Test Climb"
      frames="p1080r15"
      isMirror={false}
      renderBoard={renderBoard}
    />,
  );

  return screen.getByRole('link').getAttribute('href');
}

describe('AscentThumbnail climb-view href', () => {
  it('emits the qualified size slug for the shadowed size the ascent was logged on', () => {
    expect(thumbnailHref({ layoutId: 1, sizeId: 27, setIds: [1, 20] })).toBe(
      '/kilter/original/12x12-square-without-kickboard/screw_bolt/40/view/test-climb-ABC123',
    );
  });

  it('leaves the size that owns the bare slug on it', () => {
    expect(thumbnailHref({ layoutId: 1, sizeId: 10, setIds: [1, 20] })).toBe(
      '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-ABC123',
    );
  });
});
