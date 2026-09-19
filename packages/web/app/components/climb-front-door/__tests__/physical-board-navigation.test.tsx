import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { BoardDetails } from '@/app/lib/types';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import AngleCrossLinks from '../angle-cross-links';
import FrontDoorBreadcrumb from '../front-door-breadcrumb';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

describe('physical board front-door navigation', () => {
  it('keeps angle changes on the named board', async () => {
    const html = renderToString(
      await AngleCrossLinks({
        boardDetails: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] } as BoardDetails,
        boardSlug: 'gym #1',
        climbUuid: 'CLIMB123',
        climbName: 'Test Climb',
        currentAngle: 40,
        angleStats: [
          { angle: 25, difficulty: 'V4' },
          { angle: 40, difficulty: 'V5' },
        ] as ClimbStatsForAngle[],
      }),
    );
    expect(html).toContain('href="/b/gym%20%231/25/view/test-climb-CLIMB123"');
    expect(html).not.toContain('href="/b/gym%20%231/40/');
    expect(html).toContain('aria-current="page"');
  });

  it('keeps the visible breadcrumb on the named board without changing canonical schema', async () => {
    const canonicalList = '/kilter/original/12x12-square/screw_bolt/40/list';
    const html = renderToString(
      await FrontDoorBreadcrumb({
        boardName: 'Kilter',
        angle: 40,
        boardListUrl: canonicalList,
        navigationBoardListUrl: '/b/northside-kilter/40/list',
        leaf: { label: 'Test Climb', url: '/canonical-climb' },
      }),
    );
    expect(html).toContain('href="/b/northside-kilter/40/list"');
    expect(html).not.toContain(`href="${canonicalList}"`);
    expect(html).toContain(`"item":"https://www.boardsesh.com${canonicalList}"`);
  });
});
