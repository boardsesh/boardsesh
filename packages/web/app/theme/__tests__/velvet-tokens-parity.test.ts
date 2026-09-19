import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import { themeTokens, printSurfaceTokens } from '../theme-config';
import { darkTheme } from '../mui-theme';
// Read the literal index.css text from disk. A bundler import (?raw / glob) gets
// CSS-processed in this test env and import.meta.url is not a file: URL, so resolve the
// file from cwd against a few candidate roots instead.
function readIndexCss(): string {
  const candidates = [
    'packages/web/app/components/index.css',
    'app/components/index.css',
    'web/app/components/index.css',
  ];
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`index.css not found from cwd ${process.cwd()}`);
}
const cssText = readIndexCss();
/** Comments talk ABOUT the schemes that were removed; only real rules should match. */
const cssRules = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

// These guards exist because the Velvet Send palette lives in TWO hand-synced sources
// (theme-config.ts feeds MUI + direct imports; index.css feeds the CSS custom
// properties read by ~150 .module.css files) AND because the foreground/fill split is
// easy to wire into the wrong MUI palette slot. They assert the CONSUMPTION layer, not
// that a constant equals itself.

/** Extract the `:root { ... }` var map. There is only one scheme block. */
function extractVars(selector: string): Record<string, string> {
  const start = cssText.indexOf(selector);
  if (start === -1) throw new Error(`selector ${selector} not found in index.css`);
  const open = cssText.indexOf('{', start);
  // Brace-balanced scan to the matching close, so a future nested at-rule inside the
  // block doesn't silently truncate the var map at the first '}'.
  let depth = 0;
  let close = -1;
  for (let i = open; i < cssText.length; i++) {
    if (cssText[i] === '{') depth += 1;
    else if (cssText[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) throw new Error(`unbalanced braces after ${selector}`);
  const body = cssText.slice(open + 1, close);
  const vars: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*(--[\w-]+):\s*(.+?);/);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

const rootVars = extractVars(':root');

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, '');

describe('index.css ↔ theme-config parity', () => {
  // [cssVar, theme-config value]
  const rows: Array<[string, string]> = [
    ['--color-primary', themeTokens.colors.primary],
    ['--color-primary-hover', themeTokens.colors.primaryHover],
    ['--color-primary-fill', themeTokens.colors.primaryFill],
    ['--color-primary-fill-hover', themeTokens.colors.primaryFillHover],
    ['--color-on-primary', themeTokens.colors.onPrimary],
    ['--color-accent', themeTokens.colors.accent],
    ['--color-on-accent', themeTokens.colors.onAccent],
    ['--color-amber', themeTokens.colors.amber],
    ['--color-live', themeTokens.colors.live],
    ['--color-info', themeTokens.colors.info],
    ['--color-success', themeTokens.colors.success],
    ['--color-error', themeTokens.colors.error],
    ['--color-warning', themeTokens.colors.warning],
    ['--color-error-muted', themeTokens.colors.errorMuted],
    ['--color-error-muted-hover', themeTokens.colors.errorMutedHover],
    ['--semantic-background', themeTokens.semantic.background],
    ['--semantic-surface', themeTokens.semantic.surface],
    ['--semantic-surface-elevated', themeTokens.semantic.surfaceElevated],
    ['--semantic-selected-border', themeTokens.semantic.selectedBorder],
    ['--separator', themeTokens.semantic.separator],
    ['--control-border', themeTokens.semantic.controlBorder],
    // These two lived only in index.css until now, so the parity test could not see them
    // even though the file claims to mirror theme-config.
    ['--shadow-accent-glow', themeTokens.shadows.accentGlow],
    ['--shadow-accent-glow-hover', themeTokens.shadows.accentGlowHover],
    // Input surface: the elevated violet field. Rest of the --input-* family (no
    // theme-config counterpart) is pinned in its own block below.
    ['--input-bg', themeTokens.semantic.inputSurface],
    ['--neutral-50', themeTokens.neutral[50]],
    ['--neutral-500', themeTokens.neutral[500]],
    ['--neutral-900', themeTokens.neutral[900]],
    ['--bs-text-brand-primary', themeTokens.text.brandPrimary],
    ['--bs-text-brand-muted', themeTokens.text.brandMuted],
  ];

  it.each(rows)('%s matches theme-config', (cssVar, value) => {
    expect(rootVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(norm(rootVars[cssVar])).toBe(norm(value));
  });

  // With one scheme there is nothing left to compare a second block against, so these
  // two fences carry what the light/dark pairing used to imply on its own.
  it('no scheme block grows back in index.css', () => {
    expect(cssRules).not.toMatch(/html\[data-theme=/);
    expect(cssRules).not.toMatch(/@media\s*\(\s*prefers-color-scheme/);
  });

  it(':root declares color-scheme: dark', () => {
    // Native chrome — scrollbars, <select> popups, date pickers, autofill — reads this
    // and nothing else. It used to live inside the dark block; losing it in the fold
    // would have reverted every one of them to light widgets on a near-black page.
    expect(cssRules.slice(cssRules.indexOf(':root'), cssRules.indexOf('}'))).toMatch(/color-scheme:\s*dark/);
  });
});

// ---- WCAG contrast helper (sRGB relative luminance) ----
function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean;
  const channels = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Composite a translucent `rgba()` colour over an opaque hex background → the opaque
// colour the eye actually sees. Needed to contrast-check the semi-transparent input
// border (rgba(195,188,211,0.x)) against the field it sits on.
function blendOpaque(rgba: string, bgHex: string): string {
  const match = rgba.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`not an rgba() colour: ${rgba}`);
  const parts = match[1].split(',').map((part) => part.trim());
  const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]);
  const foreground = parts.slice(0, 3).map((channel) => parseInt(channel, 10));
  const cleanBg = bgHex.replace('#', '');
  const fullBg = cleanBg.length === 3 ? cleanBg.replace(/(.)/g, '$1$1') : cleanBg;
  const background = [0, 2, 4].map((i) => parseInt(fullBg.slice(i, i + 2), 16));
  const blended = foreground.map((channel, i) => Math.round(channel * alpha + background[i] * (1 - alpha)));
  return `#${blended.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe('MUI theme wires the foreground/fill split correctly', () => {
  it('palette.primary.main is the FOREGROUND violet (read by links/text/outlined/selection controls)', () => {
    expect(darkTheme.palette.primary.main.toLowerCase()).toBe(themeTokens.colors.primary.toLowerCase());
  });

  it('palette.primaryFill is the FILL violet with white text', () => {
    expect(darkTheme.palette.primaryFill.main.toLowerCase()).toBe(themeTokens.colors.primaryFill.toLowerCase());
    expect(darkTheme.palette.primaryFill.contrastText.toLowerCase()).toBe(themeTokens.colors.onPrimary.toLowerCase());
  });

  // THE fence for the split. With two schemes, the light rows (equal) and the dark rows
  // (divergent) together said the divergence was deliberate. One scheme says nothing —
  // two palette slots holding different violets just reads like an accident, and the
  // obvious "simplification" is to collapse them. White on #A78BFA is 2.5:1.
  it('the foreground violet and the fill violet are NOT the same colour', () => {
    expect(darkTheme.palette.primary.main.toLowerCase()).not.toBe(darkTheme.palette.primaryFill.main.toLowerCase());
    expect(themeTokens.colors.primary).not.toBe(themeTokens.colors.primaryFill);
    expect(contrast('#ffffff', themeTokens.colors.primary)).toBeLessThan(4.5);
    expect(contrast('#ffffff', themeTokens.colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary.contrastText is the DARK ink, because the foreground violet is lifted', () => {
    expect(darkTheme.palette.primary.contrastText.toLowerCase()).toBe(themeTokens.colors.onAccent.toLowerCase());
    expect(contrast(darkTheme.palette.primary.contrastText, darkTheme.palette.primary.main)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('accent is fill-only with dark text', () => {
    expect(darkTheme.palette.accent.main.toLowerCase()).toBe(themeTokens.colors.accent.toLowerCase());
    expect(darkTheme.palette.accent.contrastText.toLowerCase()).toBe(themeTokens.colors.onAccent.toLowerCase());
  });

  it('the accent ink is the shared velvet token, identical in both schemes', () => {
    // `onAccent` lives in @boardsesh/velvet-tokens so web's accent chips and the
    // mobile app's accent-filled chrome cannot drift. The accent itself is
    // scheme-agnostic, so its ink is too — a web-local literal here would let one
    // platform retune the pairing alone.
    expect(themeTokens.colors.onAccent).toBe(brandColors.onAccent);
    expect(brandColorsDark.onAccent).toBe(brandColors.onAccent);
  });

  // Web reads only the dark half of the shared package now. brandColors (light) stays
  // in @boardsesh/velvet-tokens for mobile, which still renders light — its own guard
  // lives in packages/shared/velvet-tokens/src/__tests__.
  it('the brand roles still come from @boardsesh/velvet-tokens, not web-local literals', () => {
    expect(themeTokens.colors.primary).toBe(brandColorsDark.primary);
    expect(themeTokens.colors.primaryFill).toBe(brandColorsDark.primaryFill);
    expect(themeTokens.colors.success).toBe(brandColorsDark.success);
    expect(themeTokens.colors.warning).toBe(brandColorsDark.warning);
    expect(themeTokens.colors.error).toBe(brandColorsDark.error);
    expect(themeTokens.colors.live).toBe(brandColorsDark.live);
  });
});

describe('Velvet typography ramp is pinned in px (the 16/14 coefficient does not inflate it)', () => {
  // Unpinned, MUI's coefficient (fontSize 16 / htmlFontSize 14) inflates every heading —
  // an unpinned h6 renders 22.86px. These assert the pinned px values survive theme build.
  it('heading font sizes are pinned to the intended px', () => {
    expect(darkTheme.typography.h3.fontSize).toBe(24);
    expect(darkTheme.typography.h4.fontSize).toBe(20);
    expect(darkTheme.typography.h5.fontSize).toBe(18);
    expect(darkTheme.typography.h6.fontSize).toBe(16);
  });

  it('heading font weights match the ramp', () => {
    expect(darkTheme.typography.h3.fontWeight).toBe(700);
    expect(darkTheme.typography.h4.fontWeight).toBe(600);
    expect(darkTheme.typography.h5.fontWeight).toBe(600);
    expect(darkTheme.typography.h6.fontWeight).toBe(600);
  });

  it('h3 carries the 32/24 line height', () => {
    expect(darkTheme.typography.h3.lineHeight).toBe(32 / 24);
  });

  it('button is 16/500 and keeps its casing (textTransform: none)', () => {
    expect(darkTheme.typography.button.fontSize).toBe(16);
    expect(darkTheme.typography.button.fontWeight).toBe(500);
    expect(darkTheme.typography.button.textTransform).toBe('none');
  });

  it('caption is 12/400 with a 16/12 line height', () => {
    expect(darkTheme.typography.caption.fontSize).toBe(12);
    expect(darkTheme.typography.caption.fontWeight).toBe(400);
    expect(darkTheme.typography.caption.lineHeight).toBe(16 / 12);
  });
});

describe('Velvet palette clears WCAG AA at its load-bearing pairings', () => {
  it('white text on the primary fill ≥ 4.5:1', () => {
    expect(contrast('#ffffff', themeTokens.colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark text on the amber accent ≥ 4.5:1 (via the built theme)', () => {
    expect(contrast(themeTokens.colors.onAccent, themeTokens.colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTheme.palette.accent.contrastText, darkTheme.palette.accent.main)).toBeGreaterThanOrEqual(4.5);
  });

  it('the foreground violet on the page ≥ 4.5:1', () => {
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark focus ring (foreground violet #A78BFA) clears the 3:1 UI floor on the field, card, and page', () => {
    // Inputs are no longer white in dark mode, so the focus ring is the FOREGROUND violet
    // everywhere (index.css dropped the fill-violet override). It must clear 3:1 on the
    // elevated input field, the card, and the page.
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('secondary text clears AA on its surface', () => {
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('--control-border clears the 3:1 UI-component floor on page, card and elevated surface', () => {
    // WCAG 1.4.11. This is the fence that makes the control/decorative split self-enforcing:
    // the token is opaque precisely so all three of these are checkable at once.
    const { controlBorder, background, surface, surfaceElevated } = themeTokens.semantic;
    expect(contrast(controlBorder, surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(controlBorder, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(controlBorder, background)).toBeGreaterThanOrEqual(3);
  });

  it('--separator stays BELOW 3:1, which is why it is decorative-only', () => {
    // Not a bug being tolerated — the reason the split exists. If someone "fixes" separator
    // to pass 3:1 it stops being a hairline, and this test says so before review does.
    const { separator, surface, surfaceElevated } = themeTokens.semantic;
    expect(contrast(blendOpaque(separator, surfaceElevated), surfaceElevated)).toBeLessThan(3);
    expect(contrast(blendOpaque(separator, surface), surface)).toBeLessThan(3);
  });

  it('neutral[400] is not a substitute for --control-border', () => {
    // It is the nearest neutral and the obvious thing to reach for, but it lands at 2.72:1
    // on the elevated surface. Documented here so the next person does not have to re-derive it.
    expect(contrast(themeTokens.neutral[400], themeTokens.semantic.surfaceElevated)).toBeLessThan(3);
  });
});

describe('the light-surface tokens stay legible on the white OG cards', () => {
  // printSurfaceTokens is the one place web still ships light values: the Satori cards
  // for /api/og/{profile,setter,playlist}, which render on #FFFFFF. Those routes all
  // vi.mock the token module, so nothing else checks these pairings.
  it.each([900, 800, 700, 600, 500] as const)('printSurfaceTokens.neutral[%s] clears AA on white', (step) => {
    expect(contrast(printSurfaceTokens.neutral[step], '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('the light foreground violet clears AA on white, where the dark one does not', () => {
    expect(contrast(printSurfaceTokens.primary, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.colors.primary, '#ffffff')).toBeLessThan(4.5);
  });
});

describe('Velvet dark input surface is defined, legible, and free of the elevation overlay', () => {
  // The rest of the --input-* family has no theme-config counterpart (only --input-bg
  // maps to semantic.inputSurface, asserted in the parity block). Pin the literal values
  // in both schemes so a silent drift in either scheme fails.
  const inputRows: Array<[string, string]> = [
    // Deliberately equal today: the field surface does not change on hover or focus —
    // the BORDER carries hover, the violet ring carries focus. Kept as three names so
    // the treatment can be retuned without touching ~150 .module.css call sites.
    ['--input-bg-hover', '#2f234a'],
    ['--input-bg-focused', '#2f234a'],
    ['--input-text', '#e7e2f0'],
    ['--input-placeholder', '#a9a2b6'],
    ['--input-border', 'rgba(195,188,211,0.5)'],
    ['--input-border-hover', 'rgba(195,188,211,0.7)'],
  ];
  it.each(inputRows)('%s is set', (cssVar, value) => {
    expect(rootVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(norm(rootVars[cssVar])).toBe(norm(value));
  });

  it('dark input text (#E7E2F0) clears AA on the field (#2F234A)', () => {
    expect(contrast(rootVars['--input-text'], themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark placeholder (#A9A2B6) clears AA on the field (#2F234A)', () => {
    expect(contrast(rootVars['--input-placeholder'], themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark resting border, composited over the field, clears 3:1 vs the field and vs the page', () => {
    const composited = blendOpaque(rootVars['--input-border'], themeTokens.semantic.surfaceElevated);
    expect(contrast(composited, themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(composited, themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('error text clears AA on the input field and the page', () => {
    expect(contrast(themeTokens.colors.error, themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.colors.error, themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark theme disables the MUI v7 Paper elevation overlay (backgroundImage: none)', () => {
    const paperRoot = darkTheme.components?.MuiPaper?.styleOverrides?.root as { backgroundImage?: string } | undefined;
    expect(paperRoot?.backgroundImage).toBe('none');
  });

  // Legacy floating labels (theme text.secondary) survive until the FormField waves:
  // the SHRUNK label floats over the page or a card, not the field — assert those
  // pairings so removing the old dual-tone MuiInputLabel hack can't regress contrast.
  it('floating-label text (text.secondary) clears AA over the page and the card', () => {
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });

  // Filled-variant inputs and Autocomplete ride the same --input-* family; the popup
  // paper is pinned to the elevated surface — assert its text pairing too.
  it('input text clears AA on the field (covers filled + autocomplete inputs)', () => {
    expect(contrast(rootVars['--input-text'], themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary text clears AA on the elevated popup paper (autocomplete/menu) in dark', () => {
    expect(contrast(themeTokens.neutral[800], themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  // The input slot sets `color` DIRECTLY on the <input>, which beats colour inherited
  // from the disabled wrapper — the disabled tier must be restated on the input itself
  // (both engines: color + WebkitTextFillColor) or disabled text renders full-opacity.
  it('disabled input text dims to text.disabled on the input slot itself', () => {
    const theme = darkTheme;
    const inputOverride = theme.components?.MuiInputBase?.styleOverrides?.input;
    expect(typeof inputOverride).toBe('function');
    const resolved = (inputOverride as (props: { theme: typeof theme }) => Record<string, unknown>)({ theme });
    const disabled = resolved['&.Mui-disabled'] as { color?: string; WebkitTextFillColor?: string };
    expect(disabled?.color).toBe(theme.palette.text.disabled);
    expect(disabled?.WebkitTextFillColor).toBe(theme.palette.text.disabled);
  });
});

describe('web surface ladder deliberately diverges from the shared velvet-tokens anchors', () => {
  // Web shares only the BRAND colours with @boardsesh/velvet-tokens. The SURFACE ladder
  // (page → card → elevated) is hand-tuned here to be richer/more violet than the shared
  // Material anchors (materialSurfaces), so the velvet permeates cards and greys instead
  // of reading as white + neutral grey. That divergence is INTENTIONAL. These assertions
  // pin the current web values so silent drift — in theme-config OR in velvet-tokens —
  // fails and forces a conscious design decision rather than an accidental resync.
  it('the ladder is the hand-tuned web values, each step lighter than the last', () => {
    expect(themeTokens.semantic.background).toBe('#110A20');
    expect(themeTokens.semantic.surface).toBe('#251B3A');
    expect(themeTokens.semantic.surfaceElevated).toBe('#2F234A');
    // Depth reads as a lighter violet, not a shadow — so the order must hold.
    expect(luminance(themeTokens.semantic.surface)).toBeGreaterThan(luminance(themeTokens.semantic.background));
    expect(luminance(themeTokens.semantic.surfaceElevated)).toBeGreaterThan(luminance(themeTokens.semantic.surface));
  });

  it('the web page base is intentionally NOT the shared materialSurfaces anchor', () => {
    expect(themeTokens.semantic.background.toLowerCase()).not.toBe(materialSurfaces.dark.background.toLowerCase());
    expect(themeTokens.semantic.surface.toLowerCase()).not.toBe(
      materialSurfaces.dark.secondaryBackground.toLowerCase(),
    );
  });
});
