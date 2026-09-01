import { describe, expect, it, vi } from 'vitest';

// The metrics module reads the real `spacing` / `textStyles` tokens rather than
// duplicating their values, and the token modules reach react-native for
// `PlatformColor`. Same stub the sibling board-look tests use.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  PlatformColor: (color: string) => color,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
}));

const {
  HERO_MAX_WIDTH,
  HERO_MIN_WIDTH,
  MIN_PEEK,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  RAIL_CARD_GAP,
  RAIL_THUMB_HEIGHT,
  boardLookCardHeight,
  centeredContentInset,
  neighbourPeek,
  captionBlockHeight,
  descriptionMinHeight,
  quantizeRenderWidth,
  railThumbWidth,
  resolveHeroThumb,
} = await import('../board-look-card-metrics');

/** The real extremes from BOARD_IMAGE_DIMENSIONS, not invented numbers. */
const TALLEST = 1080 / 2498; // 0.432 — Kilter 15_5_24
const LANDSCAPE = 1200 / 663; // 1.810 — Kilter 47
const COMMON = 1080 / 1755; // 0.615

describe('rail geometry', () => {
  it('keeps the settings rhythm: a rail card is still 228pt at default text size', () => {
    // The load-bearing identity. `MoreForm` pins this row's height in points from
    // a native host, so if this number moves the Board look screen's whole
    // vertical rhythm moves with it — the thing the shape change promised not to
    // touch.
    expect(boardLookCardHeight(1)).toBe(228);
  });

  it('pins the thumb by height and lets width follow the board', () => {
    // 0.94 is the commonest aspect of all (38 configs) and sits inside the clamp.
    expect(railThumbWidth(0.94)).toBe(Math.round(RAIL_THUMB_HEIGHT * 0.94));
    expect(railThumbWidth(1)).toBe(RAIL_THUMB_HEIGHT);
  });

  it('still letterboxes a tall board at the min clamp, by design', () => {
    // 168 * 0.615 = 103, under the 132 floor, so the common tall Kilter keeps
    // ~29pt of bars in the rail rather than becoming a splinter next to a
    // 0.94-aspect card. That is the deliberate trade: the square was costing 57pt
    // at this aspect, and the clamp only binds at the extremes.
    expect(railThumbWidth(COMMON)).toBe(RAIL_MIN_WIDTH);
    expect(RAIL_MIN_WIDTH - RAIL_THUMB_HEIGHT * COMMON).toBeLessThan(30);
  });

  it('clamps the extremes rather than emitting a splinter or a slab', () => {
    expect(railThumbWidth(TALLEST)).toBe(RAIL_MIN_WIDTH);
    expect(railThumbWidth(LANDSCAPE)).toBe(RAIL_MAX_WIDTH);
  });

  it('falls back to the widest card for a nonsense aspect', () => {
    expect(railThumbWidth(0)).toBe(RAIL_MAX_WIDTH);
    expect(railThumbWidth(Number.NaN)).toBe(RAIL_MAX_WIDTH);
  });
});

describe('Dynamic Type reservation', () => {
  it('grows the reservation with the text size', () => {
    // The bug this replaces: the old reservation used the UNSCALED lineHeight, so
    // above fontScale 1 the natural height exceeded it and the prop went inert —
    // leaving one-line and two-line cards with ragged bottom edges.
    expect(descriptionMinHeight(16, 1)).toBe(32);
    expect(descriptionMinHeight(16, 1.5)).toBe(48);
  });

  it('honours the same 1.5 cap the Text primitive does, and never shrinks', () => {
    expect(descriptionMinHeight(16, 3)).toBe(descriptionMinHeight(16, 1.5));
    expect(descriptionMinHeight(16, 0.8)).toBe(descriptionMinHeight(16, 1));
  });

  it('reports a taller card at accessibility text sizes', () => {
    // The pre-existing 26pt under-report that clipped the pinned native row.
    expect(boardLookCardHeight(1.5)).toBe(RAIL_THUMB_HEIGHT + captionBlockHeight({ title: 20, description: 16 }, 1.5));
    expect(boardLookCardHeight(1.5)).toBeGreaterThan(boardLookCardHeight(1));
  });

  it('reserves nothing for a description the card does not draw', () => {
    // The onboarding hero has a title and no description, and it sizes itself
    // against `railSlotHeight - captionBlockHeight(...)` — so two reserved
    // lines nobody draws are two lines taken off the picture.
    const withDescription = captionBlockHeight({ title: 25, description: 20 });
    const titleOnly = captionBlockHeight({ title: 25, description: 20 }, 1, 0);
    expect(withDescription - titleOnly).toBe(40);
    expect(titleOnly).toBeLessThan(withDescription);
  });

  it('takes the caption line heights from the caller, for the variant that differs', () => {
    // `title3` is 25 on HIG and 28 on Material. Reading it from the theme is the
    // only thing that keeps a hero caption from clipping on Android.
    const hig = captionBlockHeight({ title: 25, description: 20 });
    const material = captionBlockHeight({ title: 28, description: 20 });
    expect(material).toBeGreaterThan(hig);
  });
});

describe('hero sizing', () => {
  const PHONE = 402;

  it('is width-bound on a wide board and height-bound on a tall one', () => {
    const wide = resolveHeroThumb({ aspect: 0.94, windowWidth: PHONE, heightBudget: 541 });
    expect(wide).not.toBeNull();
    expect(wide?.width).toBe(Math.floor(PHONE * 0.72));

    const tall = resolveHeroThumb({ aspect: COMMON, windowWidth: PHONE, heightBudget: 400 });
    expect(tall?.height).toBeLessThanOrEqual(400);
  });

  it('never lets the board overflow the measured height budget', () => {
    // The blocker this rule exists for: a fraction-of-width rule gives a 0.432
    // board a 655pt card, taller than an entire iPhone SE.
    for (const aspect of [TALLEST, COMMON, 0.94, LANDSCAPE]) {
      const thumb = resolveHeroThumb({ aspect, windowWidth: PHONE, heightBudget: 460 });
      if (thumb) expect(thumb.height).toBeLessThanOrEqual(460);
    }
  });

  it('gives a landscape board a hero instead of a letterbox', () => {
    const thumb = resolveHeroThumb({ aspect: LANDSCAPE, windowWidth: PHONE, heightBudget: 460 });
    expect(thumb).not.toBeNull();
    expect(thumb!.width).toBeGreaterThan(HERO_MIN_WIDTH);
  });

  it('always leaves a peek on both sides, so the rail reads as continuing', () => {
    const thumb = resolveHeroThumb({ aspect: LANDSCAPE, windowWidth: PHONE, heightBudget: 900 });
    expect(neighbourPeek(PHONE, thumb!.width)).toBeGreaterThanOrEqual(MIN_PEEK);
  });

  it('caps the card on a big tablet rather than making a poster', () => {
    const thumb = resolveHeroThumb({ aspect: COMMON, windowWidth: 1194, heightBudget: 700 });
    expect(thumb!.width).toBeLessThanOrEqual(HERO_MAX_WIDTH);
  });

  it('refuses a hero when the slot is too short — the SE-at-AX5 fallback', () => {
    expect(resolveHeroThumb({ aspect: COMMON, windowWidth: 375, heightBudget: 175 })).toBeNull();
  });

  it('refuses a hero in a narrow window — iPad Slide Over', () => {
    expect(resolveHeroThumb({ aspect: COMMON, windowWidth: 260, heightBudget: 600 })).toBeNull();
  });

  it('refuses rather than dividing by a nonsense aspect', () => {
    expect(resolveHeroThumb({ aspect: 0, windowWidth: PHONE, heightBudget: 500 })).toBeNull();
    expect(resolveHeroThumb({ aspect: COMMON, windowWidth: PHONE, heightBudget: 0 })).toBeNull();
  });
});

describe('centring the chosen card', () => {
  const PHONE = 402;

  it('shows a slice of BOTH neighbours, not just the one behind you', () => {
    // The bug this pins: pairing the centring inset with
    // `snapToAlignment="center"` applied the centring twice, shoving every card
    // right so the trailing neighbour fell off the screen entirely. A picker that
    // shows one side reads as "you are at the end".
    const thumb = resolveHeroThumb({ aspect: COMMON, windowWidth: PHONE, heightBudget: 500 })!;
    expect(neighbourPeek(PHONE, thumb.width)).toBeGreaterThanOrEqual(MIN_PEEK);
  });

  it('centres the card: the inset is half of what the card leaves over', () => {
    // With this inset, card `i` is centred exactly when the offset is
    // `i * interval` — which is what snapping to the START of each interval
    // produces. That identity is why the alignment must stay 'start'.
    expect(centeredContentInset(PHONE, 300)).toBe(51);
    const inset = centeredContentInset(PHONE, 300);
    expect(PHONE - inset - 300).toBe(inset);
  });

  it('keeps a real peek on every board shape, including the extremes', () => {
    for (const aspect of [TALLEST, COMMON, 0.94, LANDSCAPE]) {
      const thumb = resolveHeroThumb({ aspect, windowWidth: PHONE, heightBudget: 500 });
      if (thumb) expect(neighbourPeek(PHONE, thumb.width)).toBeGreaterThanOrEqual(MIN_PEEK);
    }
  });

  it('counts the gap against the peek, since it sits between the cards', () => {
    expect(neighbourPeek(PHONE, 300)).toBe(centeredContentInset(PHONE, 300) - RAIL_CARD_GAP);
  });
});

describe('render width ladder', () => {
  it('quantizes so the whole fleet shares a couple of cache entries', () => {
    // `renderWidth` is a cache-key term, so a raw displayPt*scale would mint a
    // PNG per device width.
    expect(quantizeRenderWidth(283, 3, 1080)).toBe(1024);
    expect(quantizeRenderWidth(280, 3, 1080)).toBe(1024);
    expect(quantizeRenderWidth(310, 3, 1080)).toBe(1024);
    expect(quantizeRenderWidth(168, 2, 1080)).toBe(512);
  });

  it('never asks for more than the board has, which would be a second key for the same pixels', () => {
    expect(quantizeRenderWidth(400, 3, 1080)).toBe(1080);
  });
});
