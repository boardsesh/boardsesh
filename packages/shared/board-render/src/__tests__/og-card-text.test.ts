import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { escapePangoMarkup, MAX_CARD_NAME_CODEPOINTS, normalizeOgCardText, ogClimbQuerySchema } from '../validation';
import { renderOgCardLayers } from '../og-card';

const validQuery = {
  board_name: 'kilter',
  layout_id: '1',
  size_id: '10',
  set_ids: '1,20',
  frames: 'p1080r15',
};

describe('normalizeOgCardText', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeOgCardText('  BING   BANG\tBOSH \n', 64)).toBe('BING BANG BOSH');
  });

  it('strips control characters', () => {
    expect(normalizeOgCardText('send\u0000 it\u0007', 64)).toBe('send it');
  });

  it('strips bidi overrides, isolates and zero-width characters', () => {
    const crafted = '\u202Eevil\u202C\u200B\u2066spoof\u2069\uFEFF';

    expect(normalizeOgCardText(crafted, 64)).toBe('evilspoof');
  });

  it('normalises to NFC so equivalent names key the same', () => {
    expect(normalizeOgCardText('Cafe\u0301', 64)).toBe(normalizeOgCardText('Café', 64));
  });

  it('truncates by code point, never splitting an emoji', () => {
    const truncated = normalizeOgCardText('\u{1F9D7}\u{1F9D7}\u{1F9D7}\u{1F9D7}', 2);

    expect(Array.from(truncated)).toHaveLength(2);
    expect(truncated).toBe('\u{1F9D7}\u{1F9D7}');
    // No LONE surrogate: a valid astral pair legitimately ends in a low one.
    expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('keeps the non-Latin names the catalogue actually contains', () => {
    // Real names, sampled from live climb pages: Japanese katakana, Chinese, and
    // an emoji-only name. A script allow-list would have blanked all three.
    expect(normalizeOgCardText('カチカチ', 64)).toBe('カチカチ');
    expect(normalizeOgCardText('張力感', 64)).toBe('張力感');
    expect(normalizeOgCardText('\u{1F92E}', 64)).toBe('\u{1F92E}');
  });

  it('returns an empty string when nothing survives', () => {
    expect(normalizeOgCardText('\u200B\u202E  ', 64)).toBe('');
  });
});

describe('escapePangoMarkup', () => {
  it('escapes every character Pango would read as markup', () => {
    expect(escapePangoMarkup(`Rock & Roll <span foreground="red">'`)).toBe(
      'Rock &amp; Roll &lt;span foreground=&quot;red&quot;&gt;&#39;',
    );
  });

  it('is what stops a real climb name from throwing', async () => {
    // libvips calls pango_parse_markup unconditionally — there is no plain-text
    // mode — so an unescaped `&` is a 500, not a rendering glitch.
    await expect(
      sharp({ text: { text: 'Rock & Roll', font: 'sans 20', rgba: true } })
        .png()
        .toBuffer(),
    ).rejects.toThrow(/invalid markup/);
    await expect(
      sharp({ text: { text: escapePangoMarkup('Rock & Roll'), font: 'sans 20', rgba: true } })
        .png()
        .toBuffer(),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

describe('ogClimbQuerySchema card params', () => {
  it('accepts a query with no card params at all', () => {
    const parsed = ogClimbQuerySchema.parse(validQuery);

    expect(parsed.n).toBeUndefined();
    expect(parsed.g).toBeUndefined();
  });

  it('normalises the name and setter it keeps', () => {
    const parsed = ogClimbQuerySchema.parse({ ...validQuery, n: '  BING  BANG ', s: '\u202Ebigcheese' });

    expect(parsed.n).toBe('BING BANG');
    expect(parsed.s).toBe('bigcheese');
  });

  it('rejects an over-long name before normalising it', () => {
    const result = ogClimbQuerySchema.safeParse({ ...validQuery, n: 'a'.repeat(513) });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('n is too large');
  });

  it('truncates a long-but-allowed name to the drawn budget', () => {
    const parsed = ogClimbQuerySchema.parse({ ...validQuery, n: 'a'.repeat(200) });

    expect(Array.from(parsed.n ?? '')).toHaveLength(MAX_CARD_NAME_CODEPOINTS);
  });

  it('accepts every grade vocabulary we render', () => {
    for (const grade of ['V7', '7B+', '6c+', '5.12a', 'V8/7B', '7a/V6']) {
      expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: grade }).success, grade).toBe(true);
    }
  });

  it('rejects free text in the grade slot', () => {
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: '<b>V7</b>' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: 'カチ' }).success).toBe(false);
  });

  it('bounds the angle', () => {
    expect(ogClimbQuerySchema.parse({ ...validQuery, angle: '40' }).angle).toBe(40);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '91' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '-1' }).success).toBe(false);
  });
});

describe('renderOgCardLayers', () => {
  it('draws nothing when there is nothing to say', async () => {
    // A card built by an already-shipped client that sends no text params gets
    // the board and no empty furniture.
    expect(await renderOgCardLayers({})).toEqual([]);
  });

  it('takes its direction from whichever line the card leads with', async () => {
    // Deciding from the name alone left-anchored a card whose only words were
    // an Arabic setter.
    const ltr = await renderOgCardLayers({ grade: 'V7', setter: 'someone' });
    const rtl = await renderOgCardLayers({ grade: 'V7', setter: 'تسلق' });

    expect(ltr).not.toHaveLength(0);
    expect(rtl).not.toHaveLength(0);
    // The grade anchors to the opposite edge, so its left offset moves right.
    expect(rtl[0].left).toBeGreaterThan(ltr[0].left);
  });

  it('keeps every layer on the canvas for a name long enough to truncate', async () => {
    const layers = await renderOgCardLayers({
      name: 'A Preposterously Long Climb Name That Nobody Would Ever Actually Set On A Board',
      grade: '8a/V11',
      setter: 'verbosesetter',
      angle: 50,
      boardLine: 'Kilter · Original · 12 x 12 Square',
    });

    for (const layer of layers) {
      expect(layer.top).toBeGreaterThanOrEqual(0);
      expect(layer.top).toBeLessThan(630);
      expect(layer.left).toBeGreaterThanOrEqual(0);
    }
  });
});
