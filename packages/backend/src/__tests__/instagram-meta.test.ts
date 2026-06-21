import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import {
  clearInstagramMetaCache,
  extractInstagramCaption,
  fetchInstagramMeta,
  getInstagramMediaId,
  INSTAGRAM_META_TTL_MS,
  INSTAGRAM_TRANSIENT_TTL_MS,
  isInstagramUrl,
} from '../lib/instagram-meta';
import { logger } from '../utils/logger';

const SAMPLE_URL = 'https://www.instagram.com/p/ABC123xyz/';

function htmlWithImage(opts: { username?: string | null; src?: string } = {}): string {
  const { username = 'testclimber', src = 'https://scontent.cdninstagram.com/p1080x1080/photo.jpg' } = opts;
  const alt = username ? `Instagram post shared by &#064;${username}` : 'Instagram post';
  return `
    <html><body>
      <img class="EmbeddedMediaImage" alt="${alt}" src="${src}" />
    </body></html>
  `;
}

function htmlWithoutImage(): string {
  return `<html><body><p>No media here</p></body></html>`;
}

function mockFetchOnce(html: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(html),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('isInstagramUrl / getInstagramMediaId', () => {
  it('matches canonical post URLs', () => {
    expect(isInstagramUrl('https://www.instagram.com/p/ABC123/')).toBe(true);
    expect(isInstagramUrl('https://instagram.com/reel/XYZ_999/')).toBe(true);
    expect(isInstagramUrl('https://instagr.am/tv/foo-bar/')).toBe(true);
  });

  it('rejects non-Instagram URLs', () => {
    expect(isInstagramUrl('https://tiktok.com/@user/video/123')).toBe(false);
    expect(isInstagramUrl('https://youtube.com/watch?v=abc')).toBe(false);
  });

  it('extracts media id', () => {
    expect(getInstagramMediaId('https://www.instagram.com/p/ABC123/')).toBe('ABC123');
    expect(getInstagramMediaId('not a url')).toBeNull();
  });
});

describe('fetchInstagramMeta', () => {
  beforeEach(() => {
    clearInstagramMetaCache();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('happy path: parses thumbnail and username from EmbeddedMediaImage', async () => {
    mockFetchOnce(htmlWithImage());
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({
      status: 'ok',
      thumbnail: 'https://scontent.cdninstagram.com/p1080x1080/photo.jpg',
      username: 'testclimber',
      caption: null,
    });
  });

  it('returns gone when 200 OK but no embedded image is found', async () => {
    mockFetchOnce(htmlWithoutImage());
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'gone' });
  });

  it('maps login-wall 200 to transient_error so we keep the cached thumbnail', async () => {
    mockFetchOnce(`<html><body><a href="/accounts/login">Log in</a></body></html>`);
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'transient_error' });
  });

  it('maps rate-limit interstitial to transient_error', async () => {
    mockFetchOnce(`<html><body>Please wait a few minutes before you try again</body></html>`);
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'transient_error' });
  });

  it('returns transient_error on non-OK response', async () => {
    mockFetchOnce('', 503);
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'transient_error' });
  });

  it('returns transient_error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'transient_error' });
  });

  it('returns gone for malformed (non-Instagram) URLs without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchInstagramMeta('not a real url');
    expect(result).toEqual({ status: 'gone' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches successful results within TTL (one fetch for two calls)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(htmlWithImage()),
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = await fetchInstagramMeta(SAMPLE_URL);
    const b = await fetchInstagramMeta(SAMPLE_URL);

    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent calls for the same URL', async () => {
    let resolveBody!: (v: string) => void;
    const bodyPromise = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => bodyPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const p1 = fetchInstagramMeta(SAMPLE_URL);
    const p2 = fetchInstagramMeta(SAMPLE_URL);
    resolveBody(htmlWithImage());

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('negative-caches transient_error briefly so a rate-limit does not cause refetches on every read', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(htmlWithImage()) });
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchInstagramMeta(SAMPLE_URL);
    const second = await fetchInstagramMeta(SAMPLE_URL);

    // First call observes the transient error. Second call returns the
    // cached result without making a network request — that's the whole
    // point of the negative cache. The mock's second response (an `ok`)
    // would only be consumed after the negative TTL expires.
    expect(first).toEqual({ status: 'transient_error' });
    expect(second).toEqual({ status: 'transient_error' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches after the negative TTL expires', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve(htmlWithImage()) });
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(start);

    const first = await fetchInstagramMeta(SAMPLE_URL);
    expect(first).toEqual({ status: 'transient_error' });

    dateSpy.mockReturnValue(start + INSTAGRAM_TRANSIENT_TTL_MS + 1);

    const second = await fetchInstagramMeta(SAMPLE_URL);
    expect(second.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches after the cache TTL expires', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(htmlWithImage()),
    });
    vi.stubGlobal('fetch', fetchMock);

    const start = Date.now();
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(start);

    await fetchInstagramMeta(SAMPLE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    dateSpy.mockReturnValue(start + INSTAGRAM_META_TTL_MS + 1);
    await fetchInstagramMeta(SAMPLE_URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after a burst of transient errors and short-circuits subsequent calls', async () => {
    // 11 distinct URLs each return a transient (503). The first 10 record
    // failures and trip the breaker; the 11th call short-circuits to
    // transient_error without making a network request. We mock 11
    // responses but only expect 10 fetches to land.
    const transientResponse = { ok: false, status: 503, text: () => Promise.resolve('') };
    const fetchMock = vi.fn().mockResolvedValue(transientResponse);
    vi.stubGlobal('fetch', fetchMock);

    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(0);

    // Suppress the breaker's logger.warn so the test output stays clean.
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    for (let i = 0; i < 10; i++) {
      const result = await fetchInstagramMeta(`https://www.instagram.com/p/CIRCUIT${i}/`);
      expect(result).toEqual({ status: 'transient_error' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Eleventh URL: breaker is open, no fetch call is made.
    const blocked = await fetchInstagramMeta('https://www.instagram.com/p/CIRCUITX/');
    expect(blocked).toEqual({ status: 'transient_error' });
    expect(fetchMock).toHaveBeenCalledTimes(10);

    // Once the cooldown elapses, the breaker closes and fetches resume.
    // The default IG cooldown is 5 minutes; jump just past it and provide
    // a successful response to confirm.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(htmlWithImage()),
    });
    dateSpy.mockReturnValue(5 * 60 * 1000 + 1);
    const recovered = await fetchInstagramMeta('https://www.instagram.com/p/RECOVER/');
    expect(recovered.status).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('treats an oversized embed body as a transient error', async () => {
    // Feed a 2 MB stream past the 1 MB cap. Without the cap, a hostile
    // endpoint over a fast pipe could exhaust process memory inside the 4s
    // wall-clock budget. With the cap, the reader cancels and we surface
    // transient_error.
    const chunk = new Uint8Array(64 * 1024).fill(0x61); // 64 KB of 'a'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 32; i++) controller.enqueue(chunk); // 2 MB total
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: stream,
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({ status: 'transient_error' });
  });

  it('does not trip the circuit breaker on body-cap rejections', async () => {
    // An oversized body is a local memory-pressure defense, not an
    // IG-availability signal. Tripping the breaker on body-cap hits would
    // stop legitimate fetches for the whole cooldown window after a single
    // bad response. Feed 11 distinct URLs that each blow past the cap and
    // verify that fetch is still called on the 11th (i.e. the breaker
    // hasn't opened).
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const buildStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 32; i++) controller.enqueue(chunk); // 2 MB total
          controller.close();
        },
      });
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: buildStream(),
        text: () => Promise.resolve(''),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    for (let i = 0; i < 11; i++) {
      const result = await fetchInstagramMeta(`https://www.instagram.com/p/BODYCAP${i}/`);
      expect(result).toEqual({ status: 'transient_error' });
    }
    // All 11 attempts actually called fetch — the breaker stayed closed.
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops a username that does not match Instagram username rules', async () => {
    // Username field is captured from the embed HTML and persisted to
    // boardBetaLinks.foreign_username. An anomalous response that returns a
    // 35-character "username" or one with a leading dot shouldn't poison the
    // column — fall back to null instead.
    const malformed = `
      <html><body>
        <img class="EmbeddedMediaImage"
             alt="Instagram post shared by &#064;${'a'.repeat(35)}"
             src="https://scontent.cdninstagram.com/photo.jpg" />
      </body></html>
    `;
    mockFetchOnce(malformed);
    const result = await fetchInstagramMeta(SAMPLE_URL);
    expect(result).toEqual({
      status: 'ok',
      thumbnail: 'https://scontent.cdninstagram.com/photo.jpg',
      username: null,
      caption: null,
    });
  });

  it('accepts a 30-character username and a single-character username', async () => {
    const longBoundary = 'a'.repeat(30);
    mockFetchOnce(htmlWithImage({ username: longBoundary }));
    const longResult = await fetchInstagramMeta(SAMPLE_URL);
    expect(longResult).toMatchObject({ status: 'ok', username: longBoundary });

    clearInstagramMetaCache();
    mockFetchOnce(htmlWithImage({ username: 'x' }));
    const shortResult = await fetchInstagramMeta('https://www.instagram.com/p/SHORT_/');
    expect(shortResult).toMatchObject({ status: 'ok', username: 'x' });
  });

  it('drops usernames with leading or trailing dots', async () => {
    mockFetchOnce(htmlWithImage({ username: '.foo' }));
    const leadingDot = await fetchInstagramMeta(SAMPLE_URL);
    expect(leadingDot).toMatchObject({ status: 'ok', username: null });

    clearInstagramMetaCache();
    mockFetchOnce(htmlWithImage({ username: 'foo.' }));
    const trailingDot = await fetchInstagramMeta('https://www.instagram.com/p/TRAILDOT/');
    expect(trailingDot).toMatchObject({ status: 'ok', username: null });
  });

  // Without a body cap the streaming path enforces, the non-streaming fallback
  // (test mocks, environments without ReadableStream) has to measure UTF-8
  // bytes rather than UTF-16 code units — otherwise a body of multi-byte chars
  // can slip past a byte-denominated cap (e.g. 4-byte UTF-8 emoji puts the
  // real byte count at 4x the JS string length). Lock that in.
  it('enforces the body cap in bytes, not UTF-16 code units (fallback path)', async () => {
    // 1.2 MB of 4-byte UTF-8 characters → ~300K JS chars (text.length) but
    // ~1.2M actual bytes. The cap is 1 MB. A char-length check would let
    // this through; the byte-length check must reject it.
    const fourByteChar = '\u{1F600}'; // 😀, 4 bytes in UTF-8, 2 UTF-16 code units
    const heavyBody = fourByteChar.repeat(300_000);
    expect(heavyBody.length).toBeLessThan(1024 * 1024);
    expect(Buffer.byteLength(heavyBody, 'utf8')).toBeGreaterThan(1024 * 1024);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(heavyBody),
      // No `body` field on purpose: drives the fallback branch.
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchInstagramMeta(SAMPLE_URL);
    // readBodyWithCap throws -> fetchInstagramMeta maps to transient_error.
    expect(result).toEqual({ status: 'transient_error' });
  });
});

describe('extractInstagramCaption', () => {
  it('parses the edge_media_to_caption JSON node', () => {
    const html = `<html><script>{"edge_media_to_caption":{"edges":[{"node":{"text":"Sent Purple Nurple at 40\\u00b0 \\ud83e\\uddd7"}}]}}</script></html>`;
    expect(extractInstagramCaption(html, 'someuser')).toBe('Sent Purple Nurple at 40° 🧗');
  });

  it('parses the rendered .Caption div, dropping the leading username, despite nested divs', () => {
    const html = `
      <div class="Caption">
        <a class="CaptionUsername" href="/climber/"><div class="CaptionUsernameInner">climber</div></a>
        First ascent of <b>The Crimp Master</b>! Felt solid.
        <div class="CaptionComments">View all 12 comments</div>
      </div>`;
    expect(extractInstagramCaption(html, 'climber')).toBe('First ascent of The Crimp Master ! Felt solid.');
  });

  it('falls back to og:description and strips the like/comment prefix and quotes', () => {
    const html = `<meta property="og:description" content="1,234 likes, 56 comments - climber on Instagram: &quot;Flashed Yellow Brick Road&quot;" />`;
    expect(extractInstagramCaption(html, 'climber')).toBe('Flashed Yellow Brick Road');
  });

  it('ignores accessibility_caption when there is no real caption', () => {
    const html = `<html><script>{"accessibility_caption":"Photo by climber on January 01, 2026."}</script></html>`;
    expect(extractInstagramCaption(html, 'climber')).toBeNull();
  });

  it('returns null when nothing parseable is present', () => {
    expect(extractInstagramCaption('<html><body>no caption here</body></html>', null)).toBeNull();
  });
});
