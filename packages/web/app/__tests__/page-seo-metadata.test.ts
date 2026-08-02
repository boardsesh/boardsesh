import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

const aboutPage = await import('../about/page');
const feedPage = await import('../feed/page');
const loginPage = await import('../auth/login/page');
const playlistsPage = await import('../playlists/page');
const settingsPage = await import('../settings/page');

const aboutMetadata = await aboutPage.generateMetadata();
const feedMetadata = await feedPage.generateMetadata();
const loginMetadata = await loginPage.generateMetadata();
const playlistsMetadata = await playlistsPage.generateMetadata();
const settingsMetadata = await settingsPage.generateMetadata();

function getOpenGraphImageUrl(image: string | URL | { url: string | URL } | undefined) {
  if (!image) {
    return undefined;
  }

  if (typeof image === 'string') {
    return image;
  }

  if (image instanceof URL) {
    return image.toString();
  }

  return typeof image.url === 'string' ? image.url : image.url.toString();
}

function toOpenGraphImageList<T>(images: T | T[] | undefined): T[] {
  if (Array.isArray(images)) {
    return images;
  }
  if (images) {
    return [images];
  }
  return [];
}

describe('page metadata exports', () => {
  it('gives static marketing pages a canonical URL and default social image', () => {
    const aboutImages = toOpenGraphImageList(aboutMetadata.openGraph?.images);
    const aboutImageUrl = getOpenGraphImageUrl(aboutImages[0]);

    expect(aboutMetadata.title).toBe('About | Boardsesh');
    expect(aboutMetadata.alternates?.canonical).toBe('/about');
    expect(aboutMetadata.alternates?.languages).toEqual({
      'en-US': '/about',
      es: '/es/about',
      fr: '/fr/about',
      de: '/de/about',
      'x-default': '/about',
    });
    expect(aboutMetadata.openGraph?.url).toBe('/about');
    expect(aboutImageUrl).toBe('/opengraph-image');
    expect(aboutMetadata.twitter?.images).toEqual(['/opengraph-image']);
  });

  it('keeps utility pages out of search by default', () => {
    expect(settingsMetadata.robots).toEqual({ index: false, follow: true });
    expect(loginMetadata.robots).toEqual({ index: false, follow: true });
  });

  it('keeps the activity feed indexable so it surfaces public climbing activity', () => {
    expect(feedMetadata.robots).toBeUndefined();
    expect(feedMetadata.alternates?.canonical).toBe('/feed');
  });

  it('keeps the public playlists directory indexable because it exposes discoverable content', () => {
    expect(playlistsMetadata.title).toBe('Discover Climbing Playlists | Boardsesh');
    expect(playlistsMetadata.description).toBe(
      'Discover public climbing playlists and manage your own after signing in.',
    );
    expect(playlistsMetadata.robots).toBeUndefined();
    expect(playlistsMetadata.alternates?.canonical).toBe('/playlists');
  });

  it('sets canonical URLs on noindex pages so the route intent stays explicit', () => {
    expect(settingsMetadata.alternates?.canonical).toBe('/settings');
    expect(loginMetadata.alternates?.canonical).toBe('/auth/login');
  });
});
