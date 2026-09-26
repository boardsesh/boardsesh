import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

const rootLayout = await import('../layout');
const metadata = await rootLayout.generateMetadata();

type IconEntry = { url: string | URL; sizes?: string; type?: string };

function toEntries(value: unknown): IconEntry[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => (typeof entry === 'string' ? { url: entry } : (entry as IconEntry)));
}

// `Metadata['icons']` widens to `Icon[] | Icons | URL`; the layout always sets the
// object form, and a shape change is exactly what these assertions should catch.
const declared = metadata.icons as { icon?: unknown; apple?: unknown } | undefined;
const iconEntries = toEntries(declared?.icon);
const appleEntries = toEntries(declared?.apple);

/**
 * Nothing asserted the site's icon links before, and they had quietly drifted
 * onto a second hostname: three of the four `rel="icon"` declarations pointed at
 * assets.boardsesh.com, a DNS-only bucket host with no robots.txt and no edge
 * cache. Search engines keep one favicon per site and cache it hard, so the cost
 * of getting this wrong is measured in months.
 *
 * `app/favicon.ico` is deliberately absent from this list — Next emits that link
 * from the file convention on its own, which is also why declaring a CDN copy of
 * it alongside was a duplicate rather than an override.
 */
describe('root layout site icons', () => {
  it('declares every icon on our own origin', () => {
    const urls = [...iconEntries, ...appleEntries].map((entry) => String(entry.url));

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, `${url} is not a same-origin path`).toMatch(/^\//);
    }
  });

  it('declares the icon set exactly once each', () => {
    expect(iconEntries.map((entry) => String(entry.url))).toEqual(['/icon.png']);
    expect(appleEntries.map((entry) => String(entry.url))).toEqual(['/icons/apple-touch-icon.png']);
  });

  it('states the real pixel sizes', () => {
    expect(iconEntries[0]?.sizes).toBe('512x512');
    expect(iconEntries[0]?.type).toBe('image/png');
    expect(appleEntries[0]?.sizes).toBe('180x180');
  });

  it('matches the pixels actually on disk', async () => {
    const { default: sharp } = await import('sharp');
    const { resolve } = await import('node:path');
    const appRoot = resolve(import.meta.dirname, '..');

    const declared = [
      { path: resolve(appRoot, 'icon.png'), sizes: iconEntries[0]?.sizes },
      { path: resolve(appRoot, '../public/icons/apple-touch-icon.png'), sizes: appleEntries[0]?.sizes },
    ];

    for (const { path, sizes } of declared) {
      const { width, height } = await sharp(path).metadata();
      expect(`${width}x${height}`, `${path} does not match its declared sizes`).toBe(sizes);
    }
  });
});
