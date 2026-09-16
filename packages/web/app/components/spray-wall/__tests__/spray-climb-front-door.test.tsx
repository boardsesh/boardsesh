// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * What the spray climb page actually ships in its first HTML byte.
 *
 * The route test mocks this component away, so without this file nothing pins
 * the two things the page exists for: that a crawler which runs no JavaScript
 * gets the climb in prose, and that a presigned private-bucket URL never reaches
 * the markup.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('/')}` : key,
    locale: 'en-US',
  })),
}));

// `LocaleLink` is a client component wrapping `next/link`; a plain anchor keeps
// the assertion about the href the page emits rather than about Next's routing.
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { default: SprayClimbFrontDoor } = await import('../spray-climb-front-door');

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

async function render(overrides: { photoUrl?: string | null } = {}) {
  const element = await SprayClimbFrontDoor({
    // The component's prop types are the page's; the fixtures above are the
    // shapes those types describe, narrowed to what this component reads.
    climb: CLIMB as unknown as Parameters<typeof SprayClimbFrontDoor>[0]['climb'],
    wallData: WALL_DATA,
    photoUrl: 'photoUrl' in overrides ? (overrides.photoUrl ?? null) : WALL_DATA.wall.publicPhotoUrl,
    angle: 40,
  });
  return renderToStaticMarkup(element);
}

describe('SprayClimbFrontDoor', () => {
  it('puts the climb in the first HTML byte: one h1, a summary, and the photo', async () => {
    const html = await render();

    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('spray.heading:Crimp Ladder/6c/V5');
    expect(html).toContain('spray.summary:Garage Wall/40/220');
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

    expect(html).toContain('spray.noPhoto');
    expect(html).not.toContain('<img');
  });
});
