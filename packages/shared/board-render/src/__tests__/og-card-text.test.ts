import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { escapePangoMarkup, MAX_CARD_NAME_CODEPOINTS, normalizeOgCardText, ogClimbQuerySchema } from '../validation';
import { renderOgCardLayers } from '../og-card';
import { OG_CARD_BOARD_BOX, placeOgBoard } from '../headers';

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

  it('keeps the joiner that holds a compound emoji together', () => {
    // U+200D is text, not decoration: strip it and a climber emoji becomes two
    // glyphs. U+200C is semantic in Persian and Arabic for the same reason.
    const climber = '\u{1F9D7}\u200D\u2640\uFE0F';

    expect(normalizeOgCardText(climber, 64)).toBe(climber);
    expect(normalizeOgCardText('\u0645\u06CC\u200C\u0631\u0648\u062F', 64)).toContain('\u200C');
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

  it('keys a blank grade as no grade at all', () => {
    // The charset admits spaces, so this passed the regex, rendered nothing,
    // and still minted its own byte-cache entry.
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, g: '   ' }).success).toBe(false);
  });

  it('bounds the angle without clipping a real board', () => {
    expect(ogClimbQuerySchema.parse({ ...validQuery, angle: '40' }).angle).toBe(40);
    // Grasshopper's list starts at -5, so a negative angle has to survive;
    // `og-card-angles.test.ts` walks every board's list.
    expect(ogClimbQuerySchema.parse({ ...validQuery, angle: '-5' }).angle).toBe(-5);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '91' }).success).toBe(false);
    expect(ogClimbQuerySchema.safeParse({ ...validQuery, angle: '-91' }).success).toBe(false);
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

  it('keeps a long board line inside the column', async () => {
    // Unbounded, a line like this ran past the column and was clipped at the
    // canvas edge rather than wrapping.
    const layers = await renderOgCardLayers({
      grade: 'V4',
      boardLine: 'Touchstone \u00B7 Dungeon Trainer \u00B7 Full Size Commercial',
      setter: 'someone with quite a long name indeed',
    });

    for (const layer of layers) {
      const { width } = await sharp(layer.input).metadata();
      expect(layer.left + (width ?? 0), 'layer runs past the canvas').toBeLessThanOrEqual(1200);
    }
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

describe('card geometry and direction', () => {
  it('still draws a card that only knows the wall angle', async () => {
    // The early return used to swallow this before the angle-only row could
    // draw it, so a card with an angle and nothing else came back empty.
    expect(await renderOgCardLayers({ angle: 40 })).not.toHaveLength(0);
  });

  it('anchors the wordmark to the same edge as the text', async () => {
    const ltr = await renderOgCardLayers({ name: 'BING BANG BOSH', grade: 'V7' });
    const rtl = await renderOgCardLayers({ name: 'تسلق الصخور', grade: 'V7' });

    // The wordmark is always the last layer, and is never dropped.
    expect(rtl.at(-1)?.left).toBeGreaterThan(ltr.at(-1)?.left ?? 0);
  });

  it('never places the board outside its box', () => {
    // The scale that sizes the board and the subtraction that places it round
    // independently, so a board a fraction wider than its box must clamp rather
    // than take a negative offset that sharp clips in silence.
    const overshoot = placeOgBoard(OG_CARD_BOARD_BOX.width + 1, OG_CARD_BOARD_BOX.height + 1);

    expect(overshoot.left).toBeGreaterThanOrEqual(OG_CARD_BOARD_BOX.left);
    expect(overshoot.top).toBeGreaterThanOrEqual(OG_CARD_BOARD_BOX.top);
  });
});
