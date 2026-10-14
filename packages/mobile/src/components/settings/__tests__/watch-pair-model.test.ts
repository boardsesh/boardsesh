import { describe, expect, it, vi } from 'vitest';

// The model reads the real `spacing` token, and the token modules reach
// react-native for `PlatformColor` at import.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (spec: Record<string, unknown>) => spec.ios },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (color: string) => color,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
}));

const { WATCH_PAIR_CODE_TEXT_FIT, buildWatchPairModel, watchPairCodeHeight } = await import('../watch-pair-model');
type WatchPairModelInput = Parameters<typeof buildWatchPairModel>[0];

function makeInput(overrides: Partial<WatchPairModelInput> = {}): WatchPairModelInput {
  return {
    t: (key, options) => (options ? `${key}:${JSON.stringify(options)}` : key),
    isLoading: false,
    code: null,
    secondsLeft: 0,
    codeView: 'CODE',
    codeHeight: 65,
    onGenerate: vi.fn(),
    ...overrides,
  };
}

function rowKeys(input: WatchPairModelInput): string[] {
  return buildWatchPairModel(input).sections.flatMap((section) => section.rows.map((row) => row.key));
}

describe('buildWatchPairModel', () => {
  it('starts with one button and the instructions as the footer', () => {
    const input = makeInput();
    const [section] = buildWatchPairModel(input).sections;
    expect(section.footer).toBe('watchPairing.description');
    expect(section.title).toBeUndefined();
    expect(rowKeys(input)).toEqual(['generate']);
    const [generate] = section.rows;
    if (generate.kind !== 'button') throw new Error('expected a button');
    generate.onPress();
    expect(input.onGenerate).toHaveBeenCalledOnce();
  });

  it('shows a spinner row while a code is on its way', () => {
    const [row] = buildWatchPairModel(makeInput({ isLoading: true, code: 'ABC123', secondsLeft: 30 })).sections[0].rows;
    expect(row).toMatchObject({ kind: 'value', label: 'watchPairing.generating', busy: true });
  });

  it('shows a live code at the height it was given, with the countdown and New code', () => {
    const model = buildWatchPairModel(makeInput({ code: 'ABC123', secondsLeft: 42 }));
    const [section] = model.sections;
    expect(section.title).toBe('watchPairing.codeInstruction');
    expect(section.rows.map((row) => row.key)).toEqual(['code', 'expiresIn', 'regenerate']);
    expect(section.rows[0]).toMatchObject({ kind: 'custom', content: 'CODE', height: 65 });
    expect(section.rows[1]).toMatchObject({
      kind: 'value',
      label: 'watchPairing.expiresInLabel',
      value: 'watchPairing.secondsLeft:{"seconds":42}',
    });
  });

  it('says a lapsed code has expired and offers a new one', () => {
    expect(rowKeys(makeInput({ code: 'ABC123', secondsLeft: 0 }))).toEqual(['expired', 'regenerate']);
  });
});

describe('watchPairCodeHeight', () => {
  it('fits one large-title line plus padding at the default text size', () => {
    expect(watchPairCodeHeight(1, 41)).toBe(41 + 24);
  });

  it('grows with the climber’s text size and never shrinks below the default', () => {
    expect(watchPairCodeHeight(2, 41)).toBe(82 + 24);
    expect(watchPairCodeHeight(0.8, 41)).toBe(41 + 24);
  });

  it('stays one line tall at the largest text sizes, because the code shrinks to fit instead of wrapping', () => {
    // From about fontScale 1.5 the eight letter-spaced characters no longer fit
    // the row. A wrapped second line would sit below the pinned height, cut off,
    // so the code is held to one line and shrinks; the height counts that line.
    expect(WATCH_PAIR_CODE_TEXT_FIT).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true });
    expect(WATCH_PAIR_CODE_TEXT_FIT.minimumFontScale).toBeGreaterThan(0);
    expect(WATCH_PAIR_CODE_TEXT_FIT.minimumFontScale).toBeLessThanOrEqual(0.5);
    expect(watchPairCodeHeight(3.12, 41)).toBe(Math.ceil(41 * 3.12) + 24);
  });
});
