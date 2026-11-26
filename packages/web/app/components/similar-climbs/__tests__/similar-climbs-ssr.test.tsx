import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import type { BoardImageDetails } from '@/app/lib/types';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import SimilarClimbsList from '../similar-climbs-list';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => {
    throw new Error('read-only rows must not fetch');
  },
}));

function makeSimilarClimb(index: number): SimilarClimb {
  return {
    uuid: `SIMILAR${index}`,
    name: `Similar Boulder ${index}`,
    layoutId: 1,
    angle: 40,
    frames: `p${index}r14`,
    difficultyName: 'V4',
    setterUsername: 'setter',
    qualityAverage: 3,
    ascensionistCount: 7,
    compatibleSizeIds: [10],
  } as unknown as SimilarClimb;
}

function makeBoardDetails(): BoardImageDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 20],
    layout_name: 'Kilter Board Original',
    size_name: '12 x 12',
    size_description: 'Commercial',
    set_names: ['Bolt Ons', 'Screw Ons'],
    backgroundImagePaths: [],

    boardHeight: 100,
    boardWidth: 100,
  } as unknown as BoardImageDetails;
}

const seededClimbs = Array.from({ length: 6 }, (_, index) => makeSimilarClimb(index));

async function renderRows(overrides: Partial<React.ComponentProps<typeof SimilarClimbsList>> = {}) {
  return renderToString(
    await resolveServerTree(
      <SimilarClimbsList
        boardType="kilter"
        viewerBoardDetails={makeBoardDetails()}
        climbs={seededClimbs}
        emptyMessage="No similar climbs"
        pendingMessage="Try again later"
        {...overrides}
      />,
    ),
  );
}

describe('public related-climb server render', () => {
  it('renders every row without a query provider or browser fetch', async () => {
    const html = await renderRows();
    expect(html.match(/href="\/kilter\/[^"]*\/view\/[^"]*"/g)).toHaveLength(seededClimbs.length);
    expect(html).toContain('/view/similar-boulder-5-SIMILAR5');
    expect(html).not.toMatch(/MuiCircularProgress|<button/);
    expect(html).toContain('setter · ★3.0 · sends');
    expect(html).toContain('frontDoor.hero.gradeForSearch');
    expect(html).toContain('loading="lazy"');
  });

  it('preserves the named wall for compatible climbs', async () => {
    expect(await renderRows({ boardSlug: 'gym-wall' })).toContain(
      'href="/b/gym-wall/40/view/similar-boulder-0-SIMILAR0"',
    );
  });

  it('draws and links an incompatible Woods climb on its actual size', async () => {
    const html = await renderRows({
      boardType: 'woods',
      viewerBoardDetails: { ...makeBoardDetails(), board_name: 'woods', size_id: 2 },
      climbs: [{ ...makeSimilarClimb(0), compatibleSizeIds: [1] }],
    });
    const href = html.match(/href="(\/woods\/[^"]*)"/)?.[1] ?? '';
    expect(href).toContain('8x10');
    expect(href).not.toContain('12x12');
  });

  it('keeps unavailable distinct from genuinely empty without a client retry', async () => {
    expect(await renderRows({ climbs: undefined })).toContain('Try again later');
    expect(await renderRows({ climbs: [] })).toContain('No similar climbs');
  });
});
