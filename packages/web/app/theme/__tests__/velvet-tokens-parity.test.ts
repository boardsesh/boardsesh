import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { brandColors, brandColorsDark, materialSurfaces } from '@boardsesh/velvet-tokens';
import { themeTokens, darkTokens } from '../theme-config';
import { lightTheme, darkTheme } from '../mui-theme';
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

// These guards exist because the Velvet Send palette lives in TWO hand-synced sources
// (theme-config.ts feeds MUI + direct imports; index.css feeds the CSS custom
// properties read by ~150 .module.css files) AND because the foreground/fill split is
// easy to wire into the wrong MUI palette slot. They assert the CONSUMPTION layer, not
// that a constant equals itself.

/** Extract the `:root { ... }` (light) or `html[data-theme='dark'] { ... }` var map. */
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

const lightVars = extractVars(':root');
const darkVars = extractVars("html[data-theme='dark']");

const norm = (value: string) => value.toLowerCase().replace(/\s+/g, '');

describe('index.css ↔ theme-config parity', () => {
  // [cssVar, light theme-config value, dark theme-config value]
  const rows: Array<[string, string, string]> = [
    ['--color-primary', themeTokens.colors.primary, darkTokens.colors.primary],
    ['--color-primary-hover', themeTokens.colors.primaryHover, darkTokens.colors.primaryHover],
    ['--color-primary-fill', themeTokens.colors.primaryFill, darkTokens.colors.primaryFill],
    ['--color-primary-fill-hover', themeTokens.colors.primaryFillHover, darkTokens.colors.primaryFillHover],
    ['--color-on-primary', themeTokens.colors.onPrimary, themeTokens.colors.onPrimary],
    ['--color-accent', themeTokens.colors.accent, themeTokens.colors.accent],
    ['--color-on-accent', themeTokens.colors.onAccent, themeTokens.colors.onAccent],
    ['--color-amber', themeTokens.colors.amber, themeTokens.colors.amber],
    ['--color-live', themeTokens.colors.live, darkTokens.colors.live],
    ['--color-info', themeTokens.colors.info, darkTokens.colors.info],
    ['--color-success', themeTokens.colors.success, darkTokens.colors.success],
    ['--color-error', themeTokens.colors.error, darkTokens.colors.error],
    ['--color-warning', themeTokens.colors.warning, darkTokens.colors.warning],
    ['--color-error-muted', themeTokens.colors.errorMuted, darkTokens.colors.errorMuted],
    ['--color-error-muted-hover', themeTokens.colors.errorMutedHover, darkTokens.colors.errorMutedHover],
    ['--semantic-background', themeTokens.semantic.background, darkTokens.semantic.background],
    ['--semantic-surface', themeTokens.semantic.surface, darkTokens.semantic.surface],
    ['--semantic-selected-border', themeTokens.semantic.selectedBorder, darkTokens.semantic.selectedBorder],
    ['--separator', themeTokens.semantic.separator, darkTokens.semantic.separator],
    // Input surface: light white field, dark elevated violet. Rest of the --input-*
    // family (no theme-config counterpart) is pinned in its own block below.
    ['--input-bg', themeTokens.semantic.inputSurface, darkTokens.semantic.inputSurface],
    ['--neutral-50', themeTokens.neutral[50], darkTokens.neutral[50]],
    ['--neutral-500', themeTokens.neutral[500], darkTokens.neutral[500]],
    ['--neutral-900', themeTokens.neutral[900], darkTokens.neutral[900]],
    ['--bs-text-brand-primary', themeTokens.text.brandPrimaryLight, themeTokens.text.brandPrimary],
    ['--bs-text-brand-muted', themeTokens.text.brandMutedLight, themeTokens.text.brandMuted],
  ];

  it.each(rows)('%s matches theme-config in both schemes', (cssVar, lightValue, darkValue) => {
    expect(lightVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(darkVars[cssVar], `${cssVar} missing from dark block`).toBeDefined();
    expect(norm(lightVars[cssVar])).toBe(norm(lightValue));
    expect(norm(darkVars[cssVar])).toBe(norm(darkValue));
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
    expect(lightTheme.palette.primary.main.toLowerCase()).toBe(themeTokens.colors.primary.toLowerCase());
    expect(darkTheme.palette.primary.main.toLowerCase()).toBe(darkTokens.colors.primary.toLowerCase());
  });

  it('palette.primaryFill is the FILL violet with white text', () => {
    expect(lightTheme.palette.primaryFill.main.toLowerCase()).toBe(themeTokens.colors.primaryFill.toLowerCase());
    expect(darkTheme.palette.primaryFill.main.toLowerCase()).toBe(darkTokens.colors.primaryFill.toLowerCase());
    expect(lightTheme.palette.primaryFill.contrastText.toLowerCase()).toBe(themeTokens.colors.onPrimary.toLowerCase());
    expect(darkTheme.palette.primaryFill.contrastText.toLowerCase()).toBe(themeTokens.colors.onPrimary.toLowerCase());
  });

  it('accent is fill-only with dark text', () => {
    expect(lightTheme.palette.accent.main.toLowerCase()).toBe(themeTokens.colors.accent.toLowerCase());
    expect(lightTheme.palette.accent.contrastText.toLowerCase()).toBe(themeTokens.colors.onAccent.toLowerCase());
  });

  it('the accent ink is the shared velvet token, identical in both schemes', () => {
    // `onAccent` lives in @boardsesh/velvet-tokens so web's accent chips and the
    // mobile app's accent-filled chrome cannot drift. The accent itself is
    // scheme-agnostic, so its ink is too — a web-local literal here would let one
    // platform retune the pairing alone.
    expect(themeTokens.colors.onAccent).toBe(brandColors.onAccent);
    expect(brandColorsDark.onAccent).toBe(brandColors.onAccent);
  });
});

describe('Velvet typography ramp is pinned in px (the 16/14 coefficient does not inflate it)', () => {
  // Unpinned, MUI's coefficient (fontSize 16 / htmlFontSize 14) inflates every heading —
  // an unpinned h6 renders 22.86px. These assert the pinned px values survive theme build.
  it('heading font sizes are pinned to the intended px in both schemes', () => {
    for (const theme of [lightTheme, darkTheme]) {
      expect(theme.typography.h3.fontSize).toBe(24);
      expect(theme.typography.h4.fontSize).toBe(20);
      expect(theme.typography.h5.fontSize).toBe(18);
      expect(theme.typography.h6.fontSize).toBe(16);
    }
  });

  it('heading font weights match the ramp', () => {
    expect(lightTheme.typography.h3.fontWeight).toBe(700);
    expect(lightTheme.typography.h4.fontWeight).toBe(600);
    expect(lightTheme.typography.h5.fontWeight).toBe(600);
    expect(lightTheme.typography.h6.fontWeight).toBe(600);
  });

  it('h3 carries the 32/24 line height', () => {
    expect(lightTheme.typography.h3.lineHeight).toBe(32 / 24);
  });

  it('button is 16/500 and keeps its casing (textTransform: none)', () => {
    expect(lightTheme.typography.button.fontSize).toBe(16);
    expect(lightTheme.typography.button.fontWeight).toBe(500);
    expect(lightTheme.typography.button.textTransform).toBe('none');
  });

  it('caption is 12/400 with a 16/12 line height', () => {
    expect(lightTheme.typography.caption.fontSize).toBe(12);
    expect(lightTheme.typography.caption.fontWeight).toBe(400);
    expect(lightTheme.typography.caption.lineHeight).toBe(16 / 12);
  });
});

describe('Velvet palette clears WCAG AA at its load-bearing pairings', () => {
  it('white text on the primary fill ≥ 4.5:1 (both schemes)', () => {
    expect(contrast('#ffffff', themeTokens.colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', darkTokens.colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark text on the amber accent ≥ 4.5:1 (both schemes, via the built theme)', () => {
    expect(contrast(themeTokens.colors.onAccent, themeTokens.colors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightTheme.palette.accent.contrastText, lightTheme.palette.accent.main)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(darkTheme.palette.accent.contrastText, darkTheme.palette.accent.main)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark foreground violet on the dark page ≥ 4.5:1', () => {
    expect(contrast(darkTokens.colors.primary, darkTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark focus ring (foreground violet #A78BFA) clears the 3:1 UI floor on the field, card, and page', () => {
    // Inputs are no longer white in dark mode, so the focus ring is the FOREGROUND violet
    // everywhere (index.css dropped the fill-violet override). It must clear 3:1 on the
    // elevated input field, the card, and the page.
    expect(contrast(darkTokens.colors.primary, darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(darkTokens.colors.primary, darkTokens.semantic.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(darkTokens.colors.primary, darkTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('secondary text clears AA on its surface (both schemes)', () => {
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.neutral[500], darkTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Velvet dark input surface is defined, legible, and free of the elevation overlay', () => {
  // The rest of the --input-* family has no theme-config counterpart (only --input-bg
  // maps to semantic.inputSurface, asserted in the parity block). Pin the literal values
  // in both schemes so a silent drift in either scheme fails.
  const inputRows: Array<[string, string, string]> = [
    ['--input-bg-hover', '#f1eef7', '#2f234a'],
    ['--input-bg-focused', '#ffffff', '#2f234a'],
    ['--input-text', '#26222d', '#e7e2f0'],
    ['--input-placeholder', '#6b6577', '#a9a2b6'],
    ['--input-border', '#7b7591', 'rgba(195,188,211,0.5)'],
    ['--input-border-hover', '#595464', 'rgba(195,188,211,0.7)'],
  ];
  it.each(inputRows)('%s is set in both schemes', (cssVar, lightValue, darkValue) => {
    expect(lightVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(darkVars[cssVar], `${cssVar} missing from dark block`).toBeDefined();
    expect(norm(lightVars[cssVar])).toBe(norm(lightValue));
    expect(norm(darkVars[cssVar])).toBe(norm(darkValue));
  });

  it('dark input text (#E7E2F0) clears AA on the field (#2F234A)', () => {
    expect(contrast(darkVars['--input-text'], darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark placeholder (#A9A2B6) clears AA on the field (#2F234A)', () => {
    expect(contrast(darkVars['--input-placeholder'], darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark resting border, composited over the field, clears 3:1 vs the field and vs the page', () => {
    const composited = blendOpaque(darkVars['--input-border'], darkTokens.semantic.surfaceElevated);
    expect(contrast(composited, darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(composited, darkTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('the light resting border (#7B7591) clears 3:1 on the white field and on the page', () => {
    expect(contrast(lightVars['--input-border'], themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(lightVars['--input-border'], themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('error text clears AA on the input field and the page in both schemes (light is now #B91C1C)', () => {
    expect(contrast(themeTokens.colors.error, themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.colors.error, themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.colors.error, darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.colors.error, darkTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('the dark theme disables the MUI v7 Paper elevation overlay (backgroundImage: none)', () => {
    const paperRoot = darkTheme.components?.MuiPaper?.styleOverrides?.root as { backgroundImage?: string } | undefined;
    expect(paperRoot?.backgroundImage).toBe('none');
  });

  // Legacy floating labels (theme text.secondary) survive until the FormField waves:
  // the SHRUNK label floats over the page or a card, not the field — assert those
  // pairings so removing the old dual-tone MuiInputLabel hack can't regress contrast.
  it('floating-label text (text.secondary) clears AA over the page and the card in both schemes', () => {
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.neutral[500], darkTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.neutral[500], darkTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });

  // Filled-variant inputs and Autocomplete ride the same --input-* family; the popup
  // paper is pinned to the elevated surface — assert its text pairing too.
  it('input text clears AA on the field in both schemes (covers filled + autocomplete inputs)', () => {
    expect(contrast(lightVars['--input-text'], themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkVars['--input-text'], darkTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary text clears AA on the elevated popup paper (autocomplete/menu) in dark', () => {
    expect(contrast(darkTokens.neutral[800], darkTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
  });

  // The input slot sets `color` DIRECTLY on the <input>, which beats colour inherited
  // from the disabled wrapper — the disabled tier must be restated on the input itself
  // (both engines: color + WebkitTextFillColor) or disabled text renders full-opacity.
  it.each([
    ['light', lightTheme],
    ['dark', darkTheme],
  ] as const)('disabled input text dims to text.disabled on the input slot itself (%s)', (_scheme, theme) => {
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
  it('light ladder: page / card / elevated are the hand-tuned web values', () => {
    expect(themeTokens.semantic.background).toBe('#E8DDF6');
    expect(themeTokens.semantic.surface).toBe('#FAF6FE');
    expect(themeTokens.semantic.surfaceElevated).toBe('#FFFFFF');
  });

  it('dark ladder: page / card / elevated are the hand-tuned web values', () => {
    expect(darkTokens.semantic.background).toBe('#110A20');
    expect(darkTokens.semantic.surface).toBe('#251B3A');
    expect(darkTokens.semantic.surfaceElevated).toBe('#2F234A');
  });

  it('the web page base is intentionally NOT the shared materialSurfaces anchor (both schemes)', () => {
    expect(themeTokens.semantic.background.toLowerCase()).not.toBe(materialSurfaces.light.background.toLowerCase());
    expect(themeTokens.semantic.surface.toLowerCase()).not.toBe(
      materialSurfaces.light.secondaryBackground.toLowerCase(),
    );
    expect(darkTokens.semantic.background.toLowerCase()).not.toBe(materialSurfaces.dark.background.toLowerCase());
    expect(darkTokens.semantic.surface.toLowerCase()).not.toBe(materialSurfaces.dark.secondaryBackground.toLowerCase());
  });
});
