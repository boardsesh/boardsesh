import { describe, expect, it } from 'vite-plus/test';
import { expandAllLocales } from '../entries';
import { STATIC_ENTRIES } from '../static-entries';

// Replaces the deleted app/__tests__/sitemap.test.ts, carrying over its four
// assertions and adding the "real content timestamps" pin.
describe('static sitemap entries', () => {
  const urls = expandAllLocales(STATIC_ENTRIES).map((entry) => entry.loc);

  it('includes the homepage at the highest priority', () => {
    const home = STATIC_ENTRIES.find((entry) => entry.path === '/');
    expect(home).toBeDefined();
    expect(home?.priority).toBe(1.0);
    expect(urls).toContain('https://www.boardsesh.com');
  });

  it('includes about, help, docs and playlists', () => {
    expect(urls).toContain('https://www.boardsesh.com/about');
    expect(urls).toContain('https://www.boardsesh.com/help');
    expect(urls).toContain('https://www.boardsesh.com/docs');
    expect(urls).toContain('https://www.boardsesh.com/playlists');
  });

  it('does not include /feed or /auth paths', () => {
    expect(urls.some((url) => url.includes('/feed'))).toBe(false);
    expect(urls.some((url) => url.includes('/auth'))).toBe(false);
  });

  it('sets a real lastModified on every entry', () => {
    for (const entry of STATIC_ENTRIES) {
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it('never claims a page changed just now', () => {
    // Pins "real content timestamps, not new Date()" in CI rather than in a comment.
    // The target is a floating `new Date()` evaluated at build/module time,
    // which lands within milliseconds of the test run. A pinned literal that
    // happens to be TODAY'S date is legitimate (a page genuinely rewritten
    // today, e.g. /help on the day W-16 merged), so the window is a minute,
    // not a day.
    const aMinuteAgo = Date.now() - 60 * 1000;
    for (const entry of STATIC_ENTRIES) {
      expect(entry.lastModified!.getTime()).toBeLessThan(aMinuteAgo);
    }
  });
});
