import { describe, expect, it } from 'vite-plus/test';
import { SUPPORTED_LOCALES } from '@/app/lib/i18n/config';
import { escapeXml, MAX_ITEMS_PER_SHARD, MAX_URLS_PER_SHARD, renderSitemapIndex, renderUrlset } from '../sitemap-xml';

describe('escapeXml', () => {
  it('escapes every character that would break a shard', () => {
    expect(escapeXml(`Bob & "Al" <script> 'x'`)).toBe('Bob &amp; &quot;Al&quot; &lt;script&gt; &apos;x&apos;');
  });

  it('keeps a hostile setter username from corrupting the document', () => {
    const xml = renderUrlset([{ loc: 'https://www.boardsesh.com/setter/a%26b<c' }]);
    expect(xml).toContain('<loc>https://www.boardsesh.com/setter/a%26b&lt;c</loc>');
    expect(xml).not.toContain('<c</loc>');
  });
});

describe('renderUrlset', () => {
  it('declares the xhtml namespace only when an entry carries alternates', () => {
    const withAlternates = renderUrlset([
      { loc: 'https://www.boardsesh.com/about', alternates: { 'en-US': 'https://www.boardsesh.com/about' } },
    ]);
    const withoutAlternates = renderUrlset([{ loc: 'https://www.boardsesh.com/about' }]);

    expect(withAlternates).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(withoutAlternates).not.toContain('xmlns:xhtml');
  });

  it('omits lastmod entirely when the item has no real timestamp', () => {
    const xml = renderUrlset([{ loc: 'https://www.boardsesh.com/about', lastModified: null }]);
    expect(xml).not.toContain('<lastmod>');
  });

  it('emits the timestamp when there is a real one', () => {
    const xml = renderUrlset([
      { loc: 'https://www.boardsesh.com/playlists/abc', lastModified: new Date('2026-04-30T00:00:00.000Z') },
    ]);
    expect(xml).toContain('<lastmod>2026-04-30T00:00:00.000Z</lastmod>');
  });

  it('renders a well-formed empty urlset for a declared-empty shard', () => {
    expect(renderUrlset([])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n',
    );
  });
});

describe('renderSitemapIndex', () => {
  it('emits one <sitemap> per shard inside a <sitemapindex>', () => {
    const xml = renderSitemapIndex([
      { loc: 'https://www.boardsesh.com/sitemaps/static.xml', lastModified: new Date('2026-04-30T00:00:00.000Z') },
      { loc: 'https://www.boardsesh.com/sitemaps/boards.xml' },
    ]);

    expect(xml).toContain('<sitemapindex');
    expect(xml.match(/<sitemap>/g)).toHaveLength(2);
    expect(xml).toContain('<loc>https://www.boardsesh.com/sitemaps/boards.xml</loc>');
    expect(xml).not.toContain('<urlset');
  });
});

describe('shard budget', () => {
  it('keeps every shard under the 45k-URL cap once items are locale-expanded', () => {
    expect(MAX_ITEMS_PER_SHARD * SUPPORTED_LOCALES.length).toBeLessThanOrEqual(MAX_URLS_PER_SHARD);
  });
});
