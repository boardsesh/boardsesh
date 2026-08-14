import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import type { BoardDetails, Climb } from '@/app/lib/types';
import StaticClimbRow from '../static-climb-row';

/**
 * What the crawler actually reads. `renderToString` runs no effects, which is
 * precisely the server's situation: the reader's grade format lives in
 * IndexedDB and only resolves in an effect, so a row that waits for it ships
 * HTML with a Skeleton where the grade belongs — and the grade is the single
 * most-searched climb attribute. `showGradeWhileLoading` (climb-title.tsx) is
 * what closes that gap; these cases fail if it is dropped.
 */
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/components/board-renderer/board-image-layers', () => ({ default: () => null }));
vi.mock('@/app/components/board-renderer/board-canvas-renderer', () => ({ default: () => null }));
vi.mock('@/app/lib/board-render-worker/worker-manager', () => ({ useCanvasRendererReady: () => false }));

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'ABC123',
    setter_username: 'setter_joe',
    name: 'Test Climb',
    description: '',
    frames: 'p1080r15',
    angle: 40,
    ascensionist_count: 12,
    difficulty: '6A+/V4',
    quality_average: '3',
    stars: 3,
    mirrored: false,
    ...overrides,
  } as Climb;
}

function makeBoardDetails(): BoardDetails {
  return {
    images_to_holds: {},
    holdsData: [],
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
  };
}

function rowHtml(climb: Climb = makeClimb()) {
  return renderToString(<StaticClimbRow climb={climb} boardDetails={makeBoardDetails()} pathname="/playlists/uuid" />);
}

describe('StaticClimbRow server HTML', () => {
  it('carries the climb grade, not a placeholder', () => {
    const html = rowHtml();
    expect(html).toContain('V4');
    expect(html).not.toContain('MuiSkeleton');
  });

  it('carries the name, the setter and the send count too', () => {
    const html = rowHtml();
    expect(html).toContain('Test Climb');
    expect(html).toContain('setter_joe');
    expect(html).toContain('12');
  });

  it('falls back to the raw difficulty when it has no V-grade to format', () => {
    const html = rowHtml(makeClimb({ difficulty: '6a' }));
    expect(html).toContain('6a');
    expect(html).not.toContain('MuiSkeleton');
  });
});
