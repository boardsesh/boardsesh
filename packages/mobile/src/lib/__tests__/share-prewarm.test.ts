import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractOgImageUrl, prewarmShareCaches } from '../share-prewarm';

/**
 * The app cannot compute the card URL www advertises — that angle comes from
 * `selectCanonicalClimbAngle`, chosen from every angle's ascent counts, and the
 * same climb served at /25/, /40/ and /50/ all advertise `angle=40`. So the app
 * reads the card off the page instead of guessing at it.
 *
 * It used to guess, and the guess was a different cache key at both layers:
 * fetched back to back against production, the app-shaped URL came back MISS
 * while www's came back HIT. The prewarm was heating a URL nobody requests.
 */
describe('extractOgImageUrl', () => {
  // Copied verbatim from a production climb page, entities and all, so this
  // tracks what Next actually emits rather than a tidied-up approximation.
  const REAL_TAG =
    '<meta property="og:image" content="https://ws.boardsesh.com/og/climb?board_name=moonboard&amp;layout_id=2&amp;size_id=1&amp;set_ids=2%2C3%2C4&amp;frames=p50r42p107r43p104r43p141r43p194r44p159r43p88r43&amp;format=jpeg&amp;render_mode=aura&amp;field_color=%23181225&amp;n=Feather+Feet&amp;g=6b%2B%2FV4&amp;s=Jamesmcca826&amp;angle=40"/>';

  it('reads the card off the markup the site really serves', () => {
    const url = extractOgImageUrl(
      `<html><head>$<meta property="og:image" content="https://ws.boardsesh.com/og/climb?board_name=moonboard&amp;layout_id=2&amp;size_id=1&amp;set_ids=2%2C3%2C4&amp;frames=p50r42p107r43p104r43p141r43p194r44p159r43p88r43&amp;format=jpeg&amp;render_mode=aura&amp;field_color=%23181225&amp;n=Feather+Feet&amp;g=6b%2B%2FV4&amp;s=Jamesmcca826&amp;angle=40"/></head><body></body></html>`,
    );

    expect(url).toContain('https://ws.boardsesh.com/og/climb?');
    // The identity params are the whole point: without them this is a different
    // cache entry from the one the unfurler asks for.
    expect(url).toContain('n=Feather+Feet');
    expect(url).toContain('angle=40');
  });

  it('decodes the entities, so the URL is the one the page meant', () => {
    const url = extractOgImageUrl(
      `<head>$<meta property="og:image" content="https://ws.boardsesh.com/og/climb?board_name=moonboard&amp;layout_id=2&amp;size_id=1&amp;set_ids=2%2C3%2C4&amp;frames=p50r42p107r43p104r43p141r43p194r44p159r43p88r43&amp;format=jpeg&amp;render_mode=aura&amp;field_color=%23181225&amp;n=Feather+Feet&amp;g=6b%2B%2FV4&amp;s=Jamesmcca826&amp;angle=40"/></head>`,
    );

    expect(url).not.toContain('&amp;');
    expect(new URL(url ?? '').searchParams.get('g')).toBe('6b+/V4');
    expect(new URL(url ?? '').searchParams.get('s')).toBe('Jamesmcca826');
  });

  it('reads a tag whose attributes come in the other order', () => {
    const url = extractOgImageUrl(
      `<head><meta content="https://ws.boardsesh.com/og/climb?x=1" property="og:image"/></head>`,
    );

    expect(url).toBe('https://ws.boardsesh.com/og/climb?x=1');
  });

  it('ignores the other og tags around it', () => {
    const url = extractOgImageUrl(
      `<head>` +
        `<meta property="og:title" content="https://ws.boardsesh.com/og/climb?wrong=1"/>` +
        `<meta property="og:image:width" content="1200"/>` +
        `<meta property="og:image" content="https://ws.boardsesh.com/og/climb?right=1"/>` +
        `</head>`,
    );

    expect(url).toBe('https://ws.boardsesh.com/og/climb?right=1');
  });

  it('refuses a card pointed at someone else, rather than fetching it', () => {
    // The page is ours, but a prewarm that follows whatever a response puts in
    // og:image is a request forwarder pointed at anything that answers.
    expect(
      extractOgImageUrl(`<head><meta property="og:image" content="https://evil.example.com/og/climb?x=1"/></head>`),
    ).toBeNull();
    // Nor a lookalike host that merely starts the same way.
    expect(
      extractOgImageUrl(
        `<head><meta property="og:image" content="https://ws.boardsesh.com.evil.example/og/climb"/></head>`,
      ),
    ).toBeNull();
  });

  it('returns null rather than throwing when there is no card', () => {
    expect(extractOgImageUrl('<html><head><title>no card</title></head><body></body></html>')).toBeNull();
    expect(extractOgImageUrl('')).toBeNull();
    expect(extractOgImageUrl('not html at all')).toBeNull();
  });

  it('does not scan past the head', () => {
    // A climb page is ~326 KB and the real tag sits 1.5% in. Anything claiming
    // to be og:image down in the body is not the page's own metadata.
    const html = `<head><title>t</title></head><body>${'x'.repeat(1000)}<meta property="og:image" content="https://ws.boardsesh.com/og/climb?body=1"/></body>`;

    expect(extractOgImageUrl(html)).toBeNull();
  });
});

describe('prewarmShareCaches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PAGE = 'https://www.boardsesh.com/kilter/1/7/1,20/40/view/some-climb';
  const ADVERTISED = 'https://ws.boardsesh.com/og/climb?advertised=1';
  const FALLBACK = 'https://ws.boardsesh.com/og/climb?fallback=1';

  function stubFetch(handler: (url: string) => Promise<Response> | Response) {
    const fetched: string[] = [];
    const spy = vi.fn(async (url: string) => {
      fetched.push(url);
      return handler(url);
    });
    vi.stubGlobal('fetch', spy);
    return fetched;
  }

  function htmlAdvertising(url: string): Response {
    return { text: async () => `<head><meta property="og:image" content="${url}"/></head>` } as Response;
  }

  it('warms the card the page advertises, not the one the app guessed', async () => {
    // The whole point. The guess is a different cache key at both layers, so
    // warming it leaves the reader waiting on a cold render of the real card.
    const fetched = stubFetch((url) => (url === PAGE ? htmlAdvertising(ADVERTISED) : ({} as Response)));

    await prewarmShareCaches(PAGE, FALLBACK);

    expect(fetched).toEqual([PAGE, ADVERTISED]);
    expect(fetched).not.toContain(FALLBACK);
  });

  it('falls back to the built URL when the page advertises no card', async () => {
    const fetched = stubFetch((url) =>
      url === PAGE ? ({ text: async () => '<head><title>no card</title></head>' } as Response) : ({} as Response),
    );

    await prewarmShareCaches(PAGE, FALLBACK);

    expect(fetched).toEqual([PAGE, FALLBACK]);
  });

  it('still warms the fallback when the page fetch fails outright', async () => {
    const fetched = stubFetch((url) => {
      if (url === PAGE) throw new Error('offline');
      return {} as Response;
    });

    await prewarmShareCaches(PAGE, FALLBACK);

    expect(fetched).toEqual([PAGE, FALLBACK]);
  });

  it('never rejects, whatever fetch does', async () => {
    // Sharing must not depend on priming. A throw here would reach the caller
    // as an unhandled rejection, since nothing awaits it.
    stubFetch(() => {
      throw new Error('everything is broken');
    });

    await expect(prewarmShareCaches(PAGE, FALLBACK)).resolves.toBeUndefined();

    vi.stubGlobal('fetch', undefined);
    await expect(prewarmShareCaches(PAGE, FALLBACK)).resolves.toBeUndefined();
  });

  it('does nothing further when there is no card to warm at all', async () => {
    // Spray walls: the renderer cannot draw one, so buildOgImageUrl returns
    // null and there is nothing to fall back to.
    const fetched = stubFetch(() => ({ text: async () => '<head></head>' }) as Response);

    await prewarmShareCaches(PAGE, null);

    expect(fetched).toEqual([PAGE]);
  });
});
