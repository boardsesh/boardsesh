// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { Locale } from '@/app/lib/i18n/config';
import { getLocale } from '@/app/lib/i18n/get-locale';

/**
 * What the spray climb page actually ships in its first HTML byte.
 *
 * The route test mocks this component away, so without this file nothing pins
 * the two things the page exists for: that a crawler which runs no JavaScript
 * gets the climb in prose, and that a presigned private-bucket URL never reaches
 * the markup.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: vi.fn() }));

// `LocaleLink` is a client component wrapping `next/link`; a plain anchor keeps
// the assertion about the href the page emits rather than about Next's routing.
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// The store button is a client island that imports the analytics client.
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const { default: SprayClimbFrontDoor } = await import('../spray-climb-front-door');
const { buildStoreUrl } = await import('@/app/lib/store-links');

const PRESIGNED_URL = 'https://private.example/spray-walls/wall/photo.jpg?X-Amz-Signature=deadbeef';

const WALL_DATA = {
  versionNumber: 2,
  boardWidth: 1200,
  boardHeight: 1600,
  photo: { url: PRESIGNED_URL, width: 1200, height: 1600 },
  homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  holds: [
    { id: 101, cx: 200, cy: 400, r: 20, outline: null },
    { id: 102, cx: 600, cy: 800, r: 30, outline: [-1, -1, 1, -1, 1, 1, -1, 1] },
  ],
  wall: {
    uuid: 'ab12cd34ef56ab12cd34ef56ab12cd34',
    layoutId: 900,
    holdCount: 220,
    publicPhotoUrl: 'https://media.example/spray-walls/wall/abc.jpg',
    name: 'Garage Wall',
    angle: 40,
    gymUuid: null,
    gymName: null,
    ownerDisplayName: 'Marco',
  },
};

const CLIMB = {
  uuid: 'c0ffee00000000000000000000000001',
  name: 'Crimp Ladder',
  frames: 'p101r1p102r3',
  difficulty: '6c/V5',
  setter_username: 'marco',
  ascensionist_count: 4,
  description: 'Sit start on the two crimps.',
};

type ArtProps = Parameters<typeof SprayClimbFrontDoor>[0]['art'];

async function render(
  overrides: {
    photoUrl?: string | null;
    art?: ArtProps;
    artUrl?: string | null;
    setter?: string | null;
    senderCount?: string | number | null;
  } = {},
) {
  const { setter = CLIMB.setter_username, senderCount = CLIMB.ascensionist_count } = overrides;
  const element = await SprayClimbFrontDoor({
    // The component's prop types are the page's; the fixtures above are the
    // shapes those types describe, narrowed to what this component reads.
    climb: { ...CLIMB, setter_username: setter, ascensionist_count: senderCount } as unknown as Parameters<
      typeof SprayClimbFrontDoor
    >[0]['climb'],
    wallData: WALL_DATA,
    photoUrl: 'photoUrl' in overrides ? (overrides.photoUrl ?? null) : WALL_DATA.wall.publicPhotoUrl,
    art: overrides.art ?? null,
    artUrl: overrides.artUrl ?? null,
    angle: 40,
  });
  return renderToStaticMarkup(element);
}

describe('SprayClimbFrontDoor', () => {
  beforeEach(() => {
    vi.mocked(getLocale).mockResolvedValue('en-US');
  });

  const summaries = [
    [
      'en-US',
      'Set by marco. ',
      '1 climber logged a send.',
      '12,345 climbers logged a send.',
      '0 climbers logged a send.',
    ],
    [
      'es',
      'Equipado por marco. ',
      '1 persona ha registrado un encadene.',
      '12.345 personas han registrado un encadene.',
      '0 personas han registrado un encadene.',
    ],
    [
      'fr',
      'Ouvert par marco. ',
      '1 personne a enregistré une croix.',
      '12 345 personnes ont enregistré une croix.',
      '0 personne a enregistré une croix.',
    ],
    [
      'de',
      'Geschraubt von marco. ',
      '1 Person hat eine Begehung eingetragen.',
      '12.345 Personen haben eine Begehung eingetragen.',
      '0 Personen haben eine Begehung eingetragen.',
    ],
    [
      'it',
      'Tracciato da marco. ',
      '1 climber ha registrato una ripetizione.',
      '12.345 climber hanno registrato una ripetizione.',
      '0 climber hanno registrato una ripetizione.',
    ],
    ['zh-CN', '由 marco 设定。', '完攀记录人数：1。', '完攀记录人数：12,345。', '完攀记录人数：0。'],
  ] satisfies [Locale, string, string, string, string][];

  it.each(summaries)(
    'renders the distinct sender count in %s with or without attribution',
    async (locale, attribution, singular, grouped, zero) => {
      vi.mocked(getLocale).mockResolvedValue(locale);
      // French, Spanish and Italian can select the "many" form for an exact million.
      const format = new Intl.NumberFormat(locale);
      const million = grouped.replace(format.format(12345), format.format(1_000_000));
      for (const [senderCount, sentence] of [
        ['1', singular],
        [12345, grouped],
        [1_000_000, million],
        [null, zero],
      ] as const) {
        for (const setter of ['marco', null]) {
          const html = await render({ setter, senderCount });
          expect(html).toContain(`>${setter ? attribution : ''}${sentence}</p>`);
          expect(html.includes('href="/setter/marco"')).toBe(Boolean(setter));
        }
      }
    },
  );

  it('puts the climb in the first HTML byte: one h1, a summary, and the photo', async () => {
    const html = await render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('Crimp Ladder — 6c/V5');
    expect(html).toContain('On Garage Wall, a spray wall at 40° with 220 holds.');
    expect(html).toContain(WALL_DATA.wall.publicPhotoUrl);
    // The setter's own words are the one piece of unique prose on the page.
    expect(html).toContain('Sit start on the two crimps.');
  });

  it('draws one mark per lit hold, silhouette where the owner traced one', async () => {
    const html = await render();

    // p101 has no outline, p102 does. Both are lit by the frames string, and the
    // halo plus the role colour is two shapes each.
    expect(html.match(/<circle/g)).toHaveLength(2);
    expect(html.match(/<polygon/g)).toHaveLength(2);
  });

  it('carries three crawlable links a reader can follow', async () => {
    const html = await render();

    expect(html).toContain('href="/setter/marco"');
    expect(html).toContain('href="/gyms"');
    expect(html).toContain('href="/"');
  });

  it('ships a store link with the spray-climb link id (#6027)', async () => {
    // The page had no way to the app at all: its only links were /setter, /gyms
    // and home. Server-rendered, so it is in the HTML the CDN caches.
    const html = await render();

    expect(html).toContain(`href="${buildStoreUrl('ios', { placement: 'spray-climb' }).replaceAll('&', '&amp;')}"`);
    expect(html).toContain('ct=spray-climb');
    expect(html).toContain('Get the app');
    expect(html).toContain('Log your sends on this spray wall and set climbs of your own.');
    expect(html).toContain('App Store');
  });

  it('never puts a presigned private-bucket URL in the markup', async () => {
    // The page is CDN-cached for a day and the signature lives fifteen minutes,
    // so the URL in the HTML is always either the public copy or the redirect
    // path — never the signature `sprayWallRenderData` hands the server.
    const html = await render();

    expect(html).not.toContain(PRESIGNED_URL);
    expect(html).not.toContain('X-Amz-Signature');
  });

  it('says so rather than shipping a broken image when there is no photo', async () => {
    const html = await render({ photoUrl: null });

    expect(html).toContain('This spray wall has no photo to show yet.');
    // The store badges are the only images left: nothing points at a missing photo.
    const images = html.match(/<img [^>]*>/g) ?? [];
    expect(images.every((image) => image.includes('/images/store-badges/'))).toBe(true);
  });

  it('draws the holds-only look in canonical mode on the dark field when the owner chose it', async () => {
    const artUrl = `/api/v1/spray-walls/${WALL_DATA.wall.uuid}/photo?look=hold-cutouts`;
    // Art at half the canonical frame: canonical (200, 400) lands at (100, 200).
    const html = await render({ art: { background: 'hold-cutouts', width: 600, height: 800 }, artUrl });

    expect(html).toContain(`src="${artUrl.replaceAll('&', '&amp;')}"`);
    expect(html).not.toContain(WALL_DATA.wall.publicPhotoUrl);
    expect(html).toContain('viewBox="0 0 600 800"');
    expect(html).toContain('cx="100"');
    expect(html).toContain('cy="200"');
    expect(html).toContain('background-color:#181225');
  });

  it('draws the wall-only look with no field behind it', async () => {
    const artUrl = `/api/v1/spray-walls/${WALL_DATA.wall.uuid}/photo?look=wall-crop`;
    const html = await render({ art: { background: 'wall-crop', width: 1200, height: 1600 }, artUrl });

    expect(html).toContain('look=wall-crop');
    expect(html).not.toContain('#181225');
  });
});
