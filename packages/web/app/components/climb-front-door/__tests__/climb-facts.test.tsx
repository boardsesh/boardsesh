import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';
import ClimbFacts from '../climb-facts';

vi.mock('server-only', () => ({}));
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
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; 'aria-label'?: string }) => (
    <a href={href} aria-label={rest['aria-label']}>
      {children}
    </a>
  ),
}));

const BOARD: BoardRouteIdentity = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 10,
  set_ids: [1, 20],
  layout_name: 'Kilter Board Original',
};

const CLIMB = { uuid: 'CLIMB123', name: 'Test Climb', setter_username: 'setter-person' } as Climb;

const RATED_STATS: ClimbStatsForAngle = {
  angle: 40,
  ascensionist_count: '12',
  quality_average: '3.00',
  difficulty_average: 20,
  display_difficulty: 20,
  fa_username: 'Guill',
  fa_at: '2019-02-14T00:00:00.000Z',
  difficulty: '6c/V5',
  quality_normalized: true,
  rating_count: '12',
};

async function renderFacts(
  { climb = CLIMB, currentAngleStats }: { climb?: Climb; currentAngleStats: ClimbStatsForAngle | undefined } = {
    currentAngleStats: RATED_STATS,
  },
) {
  return renderToString(<>{await ClimbFacts({ climb, boardDetails: BOARD, angle: 40, currentAngleStats })}</>);
}

/** The `<dt>` labels, in order. */
function labels(html: string): string[] {
  return [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map((match) => match[1]);
}

describe('ClimbFacts', () => {
  it('is one <dl> of board, setter, first ascent and quality at this angle', async () => {
    const html = await renderFacts();
    expect(html.match(/<dl[\s>]/g) ?? []).toHaveLength(1);
    expect(labels(html)).toEqual([
      'frontDoor.facts.board',
      'frontDoor.facts.setter',
      'frontDoor.facts.firstAscent(angle=40)',
      'frontDoor.facts.qualityAtAngle(angle=40)',
    ]);
    expect(html).toContain('Kilter Board Original');
    expect(html).toContain('frontDoor.facts.firstAscentValue(setter=Guill,date=Feb 14, 2019)');
  });

  it('links the setter inside the list, named for a screen reader', async () => {
    const html = await renderFacts();
    const factsList = html.match(/<dl[\s>][\s\S]*<\/dl>/)?.[0] ?? '';
    expect(factsList).toContain(
      '<a href="/setter/setter-person" aria-label="frontDoor.setterLink(setter=setter-person)">setter-person</a>',
    );
  });

  it('prints a star rating only on the 1-5 scale', async () => {
    const rated = await renderFacts();
    expect(rated).toContain('★');
    expect(rated).toContain('frontDoor.hero.qualityAria(quality=3.0)');

    const aurora = await renderFacts({
      currentAngleStats: { ...RATED_STATS, quality_average: '2.40', quality_normalized: false },
    });
    expect(aurora).not.toContain('★');
    expect(aurora).toContain('frontDoor.angles.notRated');
  });

  it('says what is unknown instead of leaving a blank', async () => {
    const html = await renderFacts({
      climb: { ...CLIMB, setter_username: null } as unknown as Climb,
      currentAngleStats: undefined,
    });
    expect(html).not.toContain('/setter/');
    expect(html).toContain('frontDoor.facts.unknown');
    expect(html).toContain('frontDoor.facts.firstAscentUnknown');
    expect(html).toContain('frontDoor.angles.notRated');
  });
});
