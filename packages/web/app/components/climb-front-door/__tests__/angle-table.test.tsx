import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity } from '@/app/lib/types';
import AngleTable from '../angle-table';

vi.mock('server-only', () => ({}));
// Echoes the key and its values, so assertions read which sentence rendered and with what.
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: async () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options
        ? `${key}(${Object.entries(options)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(',')})`
        : key,
    locale: 'en-US',
  }),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const BOARD: BoardRouteIdentity = { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20] };

function statsRow(overrides: Partial<ClimbStatsForAngle> & { angle: number }): ClimbStatsForAngle {
  return {
    ascensionist_count: '0',
    quality_average: null,
    difficulty_average: null,
    display_difficulty: null,
    fa_username: null,
    fa_at: null,
    difficulty: null,
    quality_normalized: false,
    rating_count: '0',
    ...overrides,
  };
}

const STATS = [
  // Out of order on purpose: the table sorts by angle.
  statsRow({
    angle: 40,
    difficulty: '6c/V5',
    ascensionist_count: '1204',
    quality_average: '3.80',
    quality_normalized: true,
    rating_count: '40',
  }),
  statsRow({ angle: 25, difficulty: '6b/V4', ascensionist_count: '12', quality_average: '2.40' }),
  statsRow({ angle: 50, difficulty: '7a/V6', ascensionist_count: '3' }),
];

async function renderTable(props: Partial<Parameters<typeof AngleTable>[0]> = {}): Promise<string> {
  const element = await AngleTable({
    boardDetails: BOARD,
    climbUuid: 'CLIMB123',
    climbName: 'Test Climb',
    currentAngle: 40,
    angleStats: STATS,
    ...props,
  });
  return renderToString(<>{element}</>);
}

/** Each `<tr>` of the body, in render order. */
function bodyRows(html: string): string[] {
  const body = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  return body.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? [];
}

describe('AngleTable', () => {
  it('renders nothing when the climb has no stats at any angle', async () => {
    expect(
      await AngleTable({ boardDetails: BOARD, climbUuid: 'X', climbName: 'X', currentAngle: 40, angleStats: [] }),
    ).toBeNull();
  });

  it('lists every angle once, sorted, under the four column headers', async () => {
    const html = await renderTable();
    expect(html).toContain('frontDoor.angles.heading');
    expect(html.match(/scope="col"/g) ?? []).toHaveLength(4);
    for (const header of ['colAngle', 'colGrade', 'colSends', 'colQuality']) {
      expect(html).toContain(`frontDoor.angles.${header}`);
    }
    const angles = bodyRows(html).map((row) => row.match(/angleValue\(angle=(\d+)\)/)?.[1]);
    expect(angles).toEqual(['25', '40', '50']);
  });

  it('names the table by its heading and each angle link by the climb and angle', async () => {
    const html = await renderTable();
    expect(html).toMatch(/<table[^>]*aria-labelledby="angle-table-heading"/);
    expect(html).toContain('id="angle-table-heading"');
    const [link] = bodyRows(html)[0].match(/<a [\s\S]*?<\/a>/) ?? [];
    expect(link).toMatch(/aria-hidden="true"[^>]*>frontDoor\.facts\.angleValue\(angle=25\)</);
    expect(link).toContain('frontDoor.angles.linkName(climbName=Test Climb,angle=25)');
  });

  it('links every other angle on the config-tuple tree with a real href', async () => {
    const html = await renderTable();
    expect(html).toContain(`href="${buildCanonicalClimbViewUrl(BOARD, 25, 'CLIMB123', 'Test Climb')}"`);
    expect(html).toContain(`href="${buildCanonicalClimbViewUrl(BOARD, 50, 'CLIMB123', 'Test Climb')}"`);
    expect(html).not.toContain(`href="${buildCanonicalClimbViewUrl(BOARD, 40, 'CLIMB123', 'Test Climb')}"`);
  });

  it('keeps the links on the named board on the /b tree', async () => {
    const html = await renderTable({ boardSlug: 'northside kilter' });
    expect(html).toContain(`href="${constructBoardSlugViewUrl('northside%20kilter', 25, 'CLIMB123', 'Test Climb')}"`);
    expect(html).not.toContain('href="/kilter/');
  });

  it('marks the current angle as this page and never links it', async () => {
    const [, currentRow, otherRow] = bodyRows(await renderTable());
    expect(currentRow).toMatch(/^<tr[^>]*aria-current="page"/);
    expect(currentRow).toContain('frontDoor.angles.thisPage');
    expect(currentRow).not.toContain('<a ');
    expect(otherRow).not.toContain('aria-current');
    expect(otherRow).toContain('<a ');
  });

  it('prints quality only on the 1-5 scale and says "not rated" otherwise', async () => {
    const [aurora, current, unrated] = bodyRows(await renderTable());
    expect(current).toContain('frontDoor.hero.qualityAria(quality=3.8)');
    expect(current).toContain('★');
    // 2.40 on Aurora's 1-3 scale is not "2.4 out of 5".
    expect(aurora).toContain('frontDoor.angles.notRated');
    expect(aurora).not.toContain('quality=2.4');
    expect(unrated).toContain('frontDoor.angles.notRated');
  });

  it('shows the grade as a coloured chip with the grade in words for a screen reader', async () => {
    const [, current] = bodyRows(await renderTable());
    expect(current).toMatch(/<span[^>]*aria-hidden="true"[^>]*>V5<\/span>/);
    expect(current).toContain('V5 (6c)');
  });

  it('formats sends and totals them across the angles', async () => {
    const html = await renderTable();
    expect(bodyRows(html)[1]).toContain('1,204');
    expect(html).toMatch(/<tfoot[\s>]/);
    expect(html).toContain('frontDoor.angles.total(count=1219,formattedCount=1,219,angleCount=3)');
  });

  it('leaves the total out when nothing was logged or there is only one angle', async () => {
    const unsent = await renderTable({
      angleStats: [statsRow({ angle: 25, difficulty: '6b/V4' }), statsRow({ angle: 40, difficulty: '6c/V5' })],
    });
    expect(unsent).not.toContain('frontDoor.angles.total');

    const single = await renderTable({ angleStats: [STATS[0]] });
    expect(single).not.toMatch(/<tfoot[\s>]/);
  });

  it('says the grade is unknown rather than leaving an empty cell', async () => {
    const html = await renderTable({ angleStats: [statsRow({ angle: 40 })] });
    expect(bodyRows(html)[0]).toContain('frontDoor.facts.unknown');
  });
});
