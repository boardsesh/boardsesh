// @vitest-environment node
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

/**
 * What a Spraywall's own page ships in its first HTML byte (#4415).
 *
 * It is where the wall's printed QR lands, mostly on a phone with no app, and
 * where its share link lands. The route test mocks this component away, so this
 * file pins the way out of the page: an Open button into the app that keeps the
 * `?wall=` capability, and a store link that names no wall.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/i18n/server', () => ({
  getServerTranslation: vi.fn(async () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('/')}` : key,
    locale: 'en-US',
  })),
}));

vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// The store button is a client island that imports the analytics client.
vi.mock('@/app/lib/analytics', () => ({ track: vi.fn() }));

const { default: SprayWallFrontDoor } = await import('../spray-wall-front-door');
const { buildStoreUrl } = await import('@/app/lib/store-links');
const { buildNativeBoardListUrl } = await import('@/app/lib/native-app-link');

const WALL_UUID = 'ab12cd34ef56ab12cd34ef56ab12cd34';

const WALL_DATA = {
  versionNumber: 2,
  boardWidth: 1200,
  boardHeight: 1600,
  photo: { url: 'https://private.example/presigned.jpg?sig=abc', width: 1200, height: 1600 },
  homography: null,
  holds: [],
  wall: {
    uuid: WALL_UUID,
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

/** The attribute as React writes it: `&` in a URL is `&amp;` in markup. */
function asAttribute(url: string): string {
  return `href="${url.replaceAll('&', '&amp;')}"`;
}

async function render(appLink: string): Promise<string> {
  const element = await SprayWallFrontDoor({
    wallData: WALL_DATA,
    photoUrl: WALL_DATA.wall.publicPhotoUrl,
    art: null,
    artUrl: null,
    angle: 40,
    appLink,
  });
  return renderToStaticMarkup(element);
}

describe('SprayWallFrontDoor', () => {
  it('opens the wall in the app, keeping the capability an unlisted wall needs', async () => {
    const appLink = buildNativeBoardListUrl('garage-wall', 40, WALL_UUID);
    const html = await render(appLink);

    expect(html).toContain(asAttribute(`com.boardsesh.app://b/garage-wall/40/list?wall=${WALL_UUID}`));
    expect(html).toContain('spray.wall.openButton');
  });

  it("opens a public wall on its clean link, which is the one it's shared with", async () => {
    const html = await render(buildNativeBoardListUrl('garage-wall', 40));

    expect(html).toContain(asAttribute('com.boardsesh.app://b/garage-wall/40/list'));
    expect(html).not.toContain('?wall=');
  });

  it('ships both store links with the spray-wall link id, and nothing in them names the wall', async () => {
    // The HTML is stored at the edge and handed to everyone, so it carries the
    // untagged link; a scan's `.board` is added in the browser.
    const html = await render(buildNativeBoardListUrl('garage-wall', 40, WALL_UUID));

    expect(html).toContain(asAttribute(buildStoreUrl('ios', { placement: 'spray-wall' })));
    expect(html).toContain(asAttribute(buildStoreUrl('android', { placement: 'spray-wall' })));
    expect(html).toContain('ct=spray-wall');
    expect(html).toContain('spray.wall.install.helper');
    expect(html).toContain('home.hero.ctaInstallIos');
    for (const storeHref of html.match(/href="https:\/\/(apps|play)\.[^"]+"/g) ?? []) {
      expect(storeHref).not.toContain('garage');
      expect(storeHref).not.toContain(WALL_UUID);
    }
  });

  it('makes the store the primary action, and puts the Open link last and quiet', async () => {
    // A poster scan reaches this page mostly on phones with no app, and a scheme
    // link with no app behind it is an error page, so it must not come first.
    const appLink = buildNativeBoardListUrl('garage-wall', 40);
    const html = await render(appLink);
    const appStoreAt = html.indexOf(asAttribute(buildStoreUrl('ios', { placement: 'spray-wall' })));
    const openAt = html.indexOf(asAttribute(appLink));

    expect(appStoreAt).toBeGreaterThan(-1);
    expect(appStoreAt).toBeLessThan(openAt);
    expect(html.indexOf('spray.wall.haveApp')).toBeLessThan(openAt);
    // One filled button, and it is a store: the Open link is a text button.
    expect(html.match(/MuiButton-contained[\s"]/g) ?? []).toHaveLength(1);
    const openAnchor = html.slice(html.lastIndexOf('<a', openAt), openAt);
    expect(openAnchor).toContain('MuiButton-text');
    expect(openAnchor).not.toContain('MuiButton-contained');
  });

  it('keeps the scan-again line out of the shared HTML, since a shared link has nothing to scan', async () => {
    const html = await render(buildNativeBoardListUrl('garage-wall', 40));

    expect(html).not.toContain('spray.wall.install.scanAgain');
  });

  it('keeps the line that says what the app does, and the crawlable links', async () => {
    const html = await render(buildNativeBoardListUrl('garage-wall', 40));

    expect(html).toContain('spray.wall.openInApp');
    expect(html).toContain('href="/gyms"');
    expect(html).toContain('href="/"');
  });
});
