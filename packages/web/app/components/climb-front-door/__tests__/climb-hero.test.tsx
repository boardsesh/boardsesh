import React from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderToString } from 'react-dom/server';
import { resolveServerTree } from '@/app/lib/__tests__/helpers/resolve-server-tree';
import { getGradeColor, getReadableGradeInk } from '@/app/lib/grade-colors';
import GradeTile from '../grade-tile';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';

/**
 * The climb page heading (A2): the `<h1>` with its visually hidden grade, the
 * grade tile beside it, and the proof line under it.
 */

// Echoes the key and its options, so assertions can see what was asked for.
const translate = vi.hoisted(() =>
  vi.fn((key: string, options?: Record<string, unknown>) => {
    if (!options) return key;
    const flat = Object.entries(options)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(',');
    return `${key}(${flat})`;
  }),
);

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({ t: translate, locale: 'en-US' })),
}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const ClimbViewSeoFragment = (await import('@/app/components/climb-detail/climb-view-seo-fragment')).default;

const BOARD = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  layout_name: 'Kilter Board Original',
} as unknown as BoardRouteIdentity;

const CLIMB = {
  uuid: 'CLIMB',
  name: 'Test Climb',
  difficulty: '6c/V5',
  setter_username: 'setter-person',
  ascensionist_count: 4171,
  angle: 40,
} as unknown as Climb;

const NORMALIZED_STATS: ClimbStatsForAngle = {
  angle: 40,
  ascensionist_count: '4171',
  quality_average: '3.04',
  difficulty_average: 20,
  display_difficulty: 20,
  fa_username: null,
  fa_at: null,
  difficulty: '6c/V5',
  quality_normalized: true,
  rating_count: '812',
};

/** `stats: null` renders the page for an angle with no stats row. */
async function renderHero({
  climb = {},
  stats = NORMALIZED_STATS,
}: { climb?: Partial<Climb>; stats?: ClimbStatsForAngle | null } = {}) {
  const element = await ClimbViewSeoFragment({
    climb: { ...CLIMB, ...climb } as Climb,
    boardDetails: BOARD,
    angle: 40,
    currentAngleStats: stats ?? undefined,
  });
  return renderToString(<>{await resolveServerTree(element)}</>);
}

/** Emotion's SSR `<style>` tags sit between elements; drop them before matching markup. */
function withoutStyles(html: string): string {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
}

/** The text a crawler reads from the one `<h1>`, tags stripped. */
function headingText(html: string): string {
  const heading = withoutStyles(html).match(/<h1[\s>][\s\S]*?<\/h1>/)?.[0];
  if (!heading) throw new Error(`no <h1> rendered: ${html}`);
  return heading.replace(/<[^>]+>/g, '');
}

/** The `aria-hidden` grade tile's visible text, e.g. "V56C". */
function tileText(html: string): string | null {
  const tile = withoutStyles(html).match(
    /<span[^>]*aria-hidden="true"[^>]*><span[^>]*>(V[^<]*)<\/span>(?:<span[^>]*>([^<]*)<\/span>)?<\/span>/,
  );
  return tile ? `${tile[1]}${tile[2] ?? ''}` : null;
}

describe('climb page heading', () => {
  it('reads the name then the grade in one <h1>, with the grade hidden from sight', async () => {
    const html = await renderHero();
    expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
    expect(headingText(html)).toBe('Test ClimbfrontDoor.hero.gradeForSearch(grade=V5 (6c))');
  });

  it.each(['', '   '])('names an unnamed climb (%j) after its board, translated and capitalised', async (name) => {
    const html = await renderHero({ climb: { name } });
    expect(headingText(html)).toBe(
      'frontDoor.hero.unnamedClimb(board=Kilter)frontDoor.hero.gradeForSearch(grade=V5 (6c))',
    );
  });

  it('leaves the grade out of the heading for a climb without one', async () => {
    const html = await renderHero({ climb: { difficulty: null as unknown as string } });
    expect(headingText(html)).toBe('Test Climb');
  });

  it('shows the V-grade and Font grade on an aria-hidden tile in the grade colour', async () => {
    const html = await renderHero();
    expect(tileText(html)).toBe('V56C');
    // The colour is an `sx` value; read it off the element rather than out of
    // emotion's generated stylesheet.
    const tile = GradeTile({ difficulty: '6c/V5', boardName: 'kilter' }) as React.ReactElement<{
      sx: { bgcolor: string; color: string };
    }>;
    expect(tile.props.sx.bgcolor).toBe(getGradeColor('6c/V5'));
    expect(tile.props.sx.color).toBe(getReadableGradeInk(getGradeColor('6c/V5') ?? ''));
  });

  it('renders no tile for a climb with no V-grade', async () => {
    expect(tileText(await renderHero({ climb: { difficulty: null as unknown as string } }))).toBeNull();
    expect(tileText(await renderHero({ climb: { difficulty: 'project' } }))).toBeNull();
  });

  it('keeps a double-digit V-grade whole on the tile', async () => {
    const html = await renderHero({ climb: { difficulty: '8b/V14' } });
    expect(tileText(html)).toBe('V148B');
  });

  it('prints sends, the star and the setter link in the proof line', async () => {
    const html = await renderHero();
    expect(html).toContain('sends(count=4171,formattedCount=4,171)');
    expect(html).toContain('★');
    expect(html).toContain('frontDoor.hero.qualityAria(quality=3.0)');
    // The link lands inside the translated sentence, where its placeholder was.
    expect(withoutStyles(html)).toMatch(
      /frontDoor\.hero\.setBy\(setter=<a [^>]*href="\/setter\/setter-person"[^>]*>setter-person<\/a>\)/,
    );
  });

  it.each([
    ['a quality still on the Aurora 1-3 scale', { ...NORMALIZED_STATS, quality_normalized: false }],
    ['no quality at all', { ...NORMALIZED_STATS, quality_average: null, rating_count: '0' }],
    ['no stats row for the angle', null],
  ])('drops the star for %s', async (_case, stats) => {
    const html = await renderHero({ stats });
    expect(html).not.toContain('★');
    expect(html).not.toContain('frontDoor.hero.qualityAria');
  });

  it('never prints "0 sends" or an empty setter', async () => {
    const html = await renderHero({
      climb: { ascensionist_count: 0, setter_username: null as unknown as string },
      stats: null,
    });
    expect(html).not.toContain('sends(');
    expect(html).not.toContain('frontDoor.hero.setBy');
  });

  it('pluralises a send count that arrives as a numeric string', async () => {
    // i18next skips plural selection for a string `count`, which printed a bare "sends".
    const html = await renderHero({ climb: { ascensionist_count: '98482' as unknown as number } });
    expect(html).toContain('formattedCount=98,482');
    const sendsCall = translate.mock.calls.findLast(([key]) => key === 'sends');
    expect(sendsCall?.[1]).toMatchObject({ count: 98482 });
  });

  it('names the board and angle under the proof line', async () => {
    const html = await renderHero();
    expect(html).toContain('frontDoor.hero.boardAtAngle(board=Kilter Board Original,angle=40)');
  });
});
