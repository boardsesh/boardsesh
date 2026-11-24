import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  brandColors,
  brandColorsDark,
  materialOutline,
  materialSurfaceContainers,
  materialSurfaces,
  materialTonalContainers,
} from '@boardsesh/velvet-tokens';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { themeTokens } from '../theme-config';
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

// Lowercase, drop whitespace and canonicalise decimals ("0.10" and "0.1" are one alpha:
// the formatter writes the short form in CSS, velvet-tokens writes the long one).
const norm = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\d*\.\d+/g, (decimal) => String(parseFloat(decimal)));

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
    ['--semantic-selected', themeTokens.semantic.selected],
    ['--semantic-selected-hover', themeTokens.semantic.selectedHover],
    ['--semantic-selected-light', themeTokens.semantic.selectedLight],
    ['--semantic-selected-border', themeTokens.semantic.selectedBorder],
    // Roles split off the selected family so retuning `selected` cannot repaint a hover,
    // a badge ground or a dot grid. Same values as the tints they replaced.
    ['--semantic-on-selected', themeTokens.semantic.onSelected],
    ['--semantic-selected-row', themeTokens.semantic.selectedRow],
    ['--semantic-hover', themeTokens.semantic.hover],
    ['--semantic-button-hover', themeTokens.semantic.buttonHover],
    ['--semantic-fill-subtle', themeTokens.semantic.fillSubtle],
    ['--semantic-fill', themeTokens.semantic.fill],
    ['--semantic-fill-strong', themeTokens.semantic.fillStrong],
    ['--semantic-surface-overlay', themeTokens.semantic.surfaceOverlay],
    ['--separator', themeTokens.semantic.separator],
    ['--border-subtle', themeTokens.semantic.separator],
    ['--home-accent-brand-surface', themeTokens.semantic.fill],
    ['--capture-frame', themeTokens.semantic.captureFrame],
    ['--control-border', themeTokens.semantic.controlBorder],
    // Input surface: the raised Graphite field. Rest of the --input-* family (no
    // theme-config counterpart) is pinned in its own block below.
    ['--input-bg', themeTokens.semantic.inputSurface],
    ['--neutral-50', themeTokens.neutral[50]],
    ['--neutral-100', themeTokens.neutral[100]],
    ['--neutral-200', themeTokens.neutral[200]],
    ['--neutral-300', themeTokens.neutral[300]],
    ['--neutral-400', themeTokens.neutral[400]],
    ['--neutral-500', themeTokens.neutral[500]],
    ['--neutral-600', themeTokens.neutral[600]],
    ['--neutral-700', themeTokens.neutral[700]],
    ['--neutral-800', themeTokens.neutral[800]],
    ['--neutral-900', themeTokens.neutral[900]],
    ['--home-accent-info-surface', themeTokens.colors.infoTint],
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

  it('the mint CTA glow is gone from both sources', () => {
    // It belonged to the violet page. A glow that comes back in one file only would be
    // invisible to the rows above.
    expect(rootVars['--shadow-accent-glow']).toBeUndefined();
    expect(rootVars['--shadow-accent-glow-hover']).toBeUndefined();
    expect(Object.keys(themeTokens.shadows)).not.toContain('accentGlow');
    expect(Object.keys(themeTokens.shadows)).not.toContain('accentGlowHover');
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
// colour the eye actually sees. Needed to contrast-check the translucent hairlines
// (`separator`, `captureFrame`) against the surface they sit on.
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
  // obvious "simplification" is to collapse them. White on #9784FF is 2.97:1.
  it('the foreground violet and the fill violet are NOT the same colour', () => {
    expect(darkTheme.palette.primary.main.toLowerCase()).not.toBe(darkTheme.palette.primaryFill.main.toLowerCase());
    expect(themeTokens.colors.primary).not.toBe(themeTokens.colors.primaryFill);
    expect(contrast('#ffffff', themeTokens.colors.primary)).toBeLessThan(4.5);
    expect(contrast('#ffffff', themeTokens.colors.primaryFill)).toBeGreaterThanOrEqual(4.5);
  });

  it('primary.dark is the foreground violet itself, with no separate active step', () => {
    expect(darkTheme.palette.primary.dark.toLowerCase()).toBe(themeTokens.colors.primary.toLowerCase());
    expect(Object.keys(themeTokens.colors)).not.toContain('primaryActive');
  });

  it('text.disabled is the label at 38% over the page', () => {
    expect(darkTheme.palette.text.disabled.toLowerCase()).toBe('#636363');
    expect(themeTokens.text.disabled).toBe(darkTheme.palette.text.disabled);
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

  // MUI's hover and selected-row grounds read their own roles, not the selected tint,
  // so a selected-state retune cannot turn every hovered row into a selected one.
  it('action.hover and action.selected read the hover and selected-row roles', () => {
    expect(darkTheme.palette.action.hover).toBe(themeTokens.semantic.hover);
    expect(darkTheme.palette.action.selected).toBe(themeTokens.semantic.selectedRow);
  });

  it('text and outlined button hover reads the button-hover role, not the selected tint', () => {
    const buttonRoot: unknown = darkTheme.components?.MuiButton?.styleOverrides?.root;
    const hoverRule = (buttonRoot as Record<string, { backgroundColor?: string } | undefined> | undefined)?.[
      '&:not(:disabled):not(.MuiButton-contained):hover'
    ];
    expect(hoverRule?.backgroundColor).toBe('var(--semantic-button-hover)');
  });
});

/** A theme component's static `styleOverrides` slot, as a plain record for assertions. */
function overrideSlot(component: string, slot: string): Record<string, unknown> {
  const components = darkTheme.components as Record<string, { styleOverrides?: Record<string, unknown> } | undefined>;
  const value = components[component]?.styleOverrides?.[slot];
  if (typeof value !== 'object' || value === null) throw new Error(`${component}.${slot} is not a static override`);
  return value as Record<string, unknown>;
}

describe('the theme spends violet on actions and state only', () => {
  it('outlined primary buttons are the grey secondary: label ink and the control edge, on hover too', () => {
    const outlined = overrideSlot('MuiButton', 'outlinedPrimary');
    expect(outlined['--variant-outlinedColor']).toBe('var(--neutral-900)');
    expect(outlined['--variant-outlinedBorder']).toBe('var(--control-border)');
    expect(outlined.color).toBe('var(--neutral-900)');
    expect(outlined.borderColor).toBe('var(--control-border)');
    expect(outlined['@media (hover: hover)']).toEqual({
      '&:hover': { '--variant-outlinedBorder': 'var(--control-border)' },
    });
  });

  it('only a primary TEXT button (a text action) lifts its label to violet on hover', () => {
    const hoverRule = overrideSlot('MuiButton', 'root')['&:not(:disabled):not(.MuiButton-contained):hover'] as Record<
      string,
      unknown
    >;
    expect(hoverRule['&.MuiButton-textPrimary']).toEqual({ color: 'var(--color-primary-hover)' });
    expect(hoverRule).not.toHaveProperty('&.MuiButton-colorPrimary');
  });

  it('links are violet and always underlined, 3px below the baseline', () => {
    expect(darkTheme.components?.MuiLink?.defaultProps?.underline).toBe('always');
    expect(overrideSlot('MuiLink', 'root').textUnderlineOffset).toBe('3px');
    expect(darkTheme.palette.primary.main).toBe(themeTokens.colors.primary);
  });

  it.each([
    ['MuiToggleButton', '&.Mui-selected'],
    ['MuiMenuItem', '&.Mui-selected, &.Mui-selected.Mui-focusVisible'],
  ])('a selected %s is the tonal container with its own ink', (component, selector) => {
    expect(overrideSlot(component, 'root')[selector]).toMatchObject({
      color: 'var(--semantic-on-selected)',
      backgroundColor: 'var(--semantic-selected)',
    });
  });

  it('a resting toggle is a grey control, with its hover wash on pointer devices only', () => {
    const toggle = overrideSlot('MuiToggleButton', 'root');
    expect(toggle.color).toBe('var(--neutral-900)');
    expect(toggle.borderColor).toBe('var(--control-border)');
    expect(toggle['@media (hover: hover)']).toEqual({ '&:hover': { backgroundColor: 'var(--semantic-hover)' } });
    expect(toggle).not.toHaveProperty('&:hover');
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

  it.each(['background', 'surface', 'surfaceElevated'] as const)(
    'the foreground violet reads as text on %s (≥ 4.5:1)',
    (ground) => {
      // Links and text actions: 6.49:1 on the page, 5.60:1 on the card, 5.09:1 on the
      // raised surface. The same numbers carry the 2px focus ring past its 3:1 floor.
      expect(contrast(themeTokens.colors.primary, themeTokens.semantic[ground])).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('the focus ring (foreground violet #9784FF) clears the 3:1 UI floor on the field, card, and page', () => {
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primary, themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
  });

  it('the filled CTA keeps a 3:1 edge on the raised surface and loses it one step higher', () => {
    // WCAG 1.4.11 for the filled pill: #7855FF is 3.27:1 on #262626 but 2.94:1 on
    // #2E2E2E (neutral[200], containers.highest). That second number is why a filled CTA
    // never sits above surfaceElevated; the assertion documents the line.
    expect(contrast(themeTokens.colors.primaryFill, themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primaryFill, themeTokens.semantic.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primaryFill, themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(themeTokens.colors.primaryFill, themeTokens.neutral[200])).toBeLessThan(3);
  });

  it('the selected container carries its own ink, never the foreground violet', () => {
    // Tonal #34276B with #E1E0FF: 9.89:1, and 8.05:1 on the hover step. The foreground
    // violet on it is 4.28:1, under AA, so a selected item never uses it as its label.
    const { selected, selectedHover, onSelected } = themeTokens.semantic;
    expect(contrast(onSelected, selected)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(onSelected, selectedHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.colors.primary, selected)).toBeLessThan(4.5);
  });

  it('the current-angle ink reads on the card it sits on today', () => {
    // list-angle-rail's current stop draws --semantic-on-selected on --semantic-surface
    // until the recipe moves it onto the tonal container: 12.95:1.
    expect(contrast(themeTokens.semantic.onSelected, themeTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['background', themeTokens.semantic.background],
    ['surface', themeTokens.semantic.surface],
    ['surfaceElevated', themeTokens.semantic.surfaceElevated],
    ['neutral[50]', themeTokens.neutral[50]],
    ['neutral[100]', themeTokens.neutral[100]],
    ['neutral[200]', themeTokens.neutral[200]],
  ])('the grey secondary ink (outlined buttons, resting chips) clears AA on %s', (_name, ground) => {
    // #EDEDED: 16.49:1 on the page down to 11.60:1 on neutral[200]. The outlined
    // recipe and every resting chip and toggle draw their label in it.
    expect(contrast(themeTokens.neutral[900], ground)).toBeGreaterThanOrEqual(4.5);
  });

  it('secondary text clears AA on every surface step, up to neutral[200]', () => {
    // #B0B0B0: 8.90:1 on the page, 6.26:1 on containers.highest (the worst case).
    for (const ground of [
      themeTokens.semantic.background,
      themeTokens.semantic.surface,
      themeTokens.semantic.surfaceElevated,
      themeTokens.neutral[200],
    ]) {
      expect(contrast(themeTokens.neutral[500], ground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the tertiary label (neutral[400]) clears AA up to the raised surface and not above it', () => {
    // #8F8F8F: 5.15:1 on the card, 4.68:1 on #262626, 4.20:1 on #2E2E2E. It stays off
    // neutral[200], the same placement rule the app holds.
    expect(contrast(themeTokens.neutral[400], themeTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.neutral[400], themeTokens.semantic.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(themeTokens.neutral[400], themeTokens.neutral[200])).toBeLessThan(4.5);
  });

  it.each(['surface', 'surfaceRaised'] as const)(
    'every text colour on the shared page tokens (/help %s) clears AA',
    (ground) => {
      const backdrop = ground === 'surface' ? themeTokens.semantic.background : themeTokens.semantic.surface;
      expect(contrast(themeTokens.neutral[900], backdrop)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(themeTokens.neutral[500], backdrop)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(themeTokens.colors.primary, backdrop)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(themeTokens.colors.info, backdrop)).toBeGreaterThanOrEqual(4.5);
      // Outlined controls on the reading surface use --control-border.
      expect(contrast(themeTokens.semantic.controlBorder, backdrop)).toBeGreaterThanOrEqual(3);
    },
  );

  it.each([
    ['background', themeTokens.semantic.background],
    ['surface', themeTokens.semantic.surface],
    ['surfaceElevated', themeTokens.semantic.surfaceElevated],
    ['neutral[50]', themeTokens.neutral[50]],
    ['neutral[100]', themeTokens.neutral[100]],
    ['neutral[200]', themeTokens.neutral[200]],
  ])('--control-border clears the 3:1 UI-component floor on %s', (_name, ground) => {
    // WCAG 1.4.11. This is the fence that makes the control/decorative split self-enforcing:
    // the token is opaque precisely so every step is checkable at once. #8A8A8A runs from
    // 5.59:1 on the page down to 3.93:1 on neutral[200].
    expect(contrast(themeTokens.semantic.controlBorder, ground)).toBeGreaterThanOrEqual(3);
  });

  it('--separator stays BELOW 3:1, which is why it is decorative-only', () => {
    // Not a bug being tolerated — the reason the split exists. If someone "fixes" separator
    // to pass 3:1 it stops being a hairline, and this test says so before review does.
    const { separator, captureFrame, background, surface, surfaceElevated } = themeTokens.semantic;
    for (const ground of [background, surface, surfaceElevated]) {
      expect(contrast(blendOpaque(separator, ground), ground)).toBeLessThan(3);
      // The capture frame is a hairline too, a shade brighter.
      expect(contrast(blendOpaque(captureFrame, ground), ground)).toBeLessThan(3);
    }
  });
});

describe('Velvet dark input surface is defined, legible, and free of the elevation overlay', () => {
  // The rest of the --input-* family has no theme-config counterpart (only --input-bg
  // maps to semantic.inputSurface, asserted in the parity block). Each row ties the var to
  // the Graphite role it carries, so a silent drift on either side fails.
  const inputRows: Array<[string, string]> = [
    // Deliberately equal today: the field surface does not change on hover or focus —
    // the BORDER carries hover, the violet ring carries focus. Kept as three names so
    // the treatment can be retuned without touching ~150 .module.css call sites.
    ['--input-bg-hover', themeTokens.semantic.inputSurface],
    ['--input-bg-focused', themeTokens.semantic.inputSurface],
    ['--input-text', materialSurfaces.dark.label],
    ['--input-placeholder', materialSurfaces.dark.secondaryLabel],
    // The resting edge is the control border: opaque, so its contrast is one fact.
    ['--input-border', themeTokens.semantic.controlBorder],
    ['--input-border-hover', materialSurfaces.dark.label],
  ];
  it.each(inputRows)('%s is set', (cssVar, value) => {
    expect(rootVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(norm(rootVars[cssVar])).toBe(norm(value));
  });

  it('input text clears AA on the field', () => {
    expect(contrast(rootVars['--input-text'], themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('the placeholder clears AA on the field', () => {
    expect(contrast(rootVars['--input-placeholder'], themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(4.5);
  });

  it('the resting and hover borders clear 3:1 vs the field and vs the page', () => {
    // Both are opaque now, so no compositing: 4.38:1 and 5.59:1 at rest.
    for (const border of [rootVars['--input-border'], rootVars['--input-border-hover']]) {
      expect(contrast(border, themeTokens.semantic.inputSurface)).toBeGreaterThanOrEqual(3);
      expect(contrast(border, themeTokens.semantic.background)).toBeGreaterThanOrEqual(3);
    }
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

  it('primary text clears AA on the elevated popup paper (autocomplete/menu)', () => {
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

describe('the web surface ladder is the Graphite ladder the app uses', () => {
  // www used to keep its own violet page → card → elevated ladder and this block pinned the
  // divergence. It now reads the shared Material anchors, so the seam into the Expo
  // browser app at /app is gone. These assertions keep it that way: a web-local literal or
  // a retune on one side only fails here.
  it('page, card and elevated surface ARE materialSurfaces.dark', () => {
    expect(themeTokens.semantic.background).toBe(materialSurfaces.dark.background);
    expect(themeTokens.semantic.surface).toBe(materialSurfaces.dark.secondaryBackground);
    expect(themeTokens.semantic.surfaceElevated).toBe(materialSurfaces.dark.elevatedSurface);
    expect(themeTokens.semantic.inputSurface).toBe(materialSurfaces.dark.elevatedSurface);
  });

  it('each step is lighter than the last', () => {
    // Depth reads as a lighter grey, not a shadow — so the order must hold.
    expect(luminance(themeTokens.semantic.surface)).toBeGreaterThan(luminance(themeTokens.semantic.background));
    expect(luminance(themeTokens.semantic.surfaceElevated)).toBeGreaterThan(luminance(themeTokens.semantic.surface));
  });

  it('labels, hairline, outline and fill are the shared Graphite roles', () => {
    expect(themeTokens.neutral[900]).toBe(materialSurfaces.dark.label);
    expect(themeTokens.neutral[500]).toBe(materialSurfaces.dark.secondaryLabel);
    expect(themeTokens.neutral[400]).toBe(materialSurfaces.dark.tertiaryLabel);
    expect(themeTokens.colors.secondary).toBe(materialSurfaces.dark.secondaryLabel);
    expect(themeTokens.semantic.separator).toBe(materialSurfaces.dark.separator);
    expect(themeTokens.semantic.fill).toBe(materialSurfaces.dark.fill);
    expect(themeTokens.semantic.controlBorder).toBe(materialOutline.dark);
  });

  it('the surface steps of the neutral ramp are the shared container ladder', () => {
    expect(themeTokens.neutral[50]).toBe(materialSurfaceContainers.dark.base);
    expect(themeTokens.neutral[100]).toBe(materialSurfaceContainers.dark.high);
    expect(themeTokens.neutral[200]).toBe(materialSurfaceContainers.dark.highest);
  });

  it('the selected state is the opaque tonal container with its ink', () => {
    expect(themeTokens.semantic.selected).toBe(materialTonalContainers.dark.secondaryContainer);
    expect(themeTokens.semantic.onSelected).toBe(materialTonalContainers.dark.ink);
  });

  it('MUI action.selected stays a neutral fill, never violet', () => {
    // MUI paints it under every default filled Chip, a selected PaginationItem and the
    // highlighted Autocomplete option; a violet value would tint all of them.
    expect(themeTokens.semantic.selectedRow).toBe(materialSurfaces.dark.fill);
  });
});

// The marketing layer: four lit hold roles and the tray radius, read only by www
// marketing pages. The colours come from the board catalogue, so a page ring always
// matches the hold the app draws; index.css has to follow.
describe('the marketing lit-hold layer', () => {
  const litRows: Array<[string, string]> = [
    ['--lit-start', themeTokens.marketing.lit.start],
    ['--lit-hand', themeTokens.marketing.lit.hand],
    ['--lit-finish', themeTokens.marketing.lit.finish],
    ['--lit-foot', themeTokens.marketing.lit.foot],
  ];

  it.each(litRows)('%s matches the board-constants role colour', (cssVar, value) => {
    expect(rootVars[cssVar], `${cssVar} missing from :root`).toBeDefined();
    expect(norm(rootVars[cssVar])).toBe(norm(value));
  });

  it('reads the roles from HOLD_STATE_MAP, with Boardsesh’s own hand cyan', () => {
    const kilter = HOLD_STATE_MAP.kilter;
    expect(themeTokens.marketing.lit).toEqual({
      start: kilter[12].color,
      hand: kilter[13].boardseshDisplayColor,
      finish: kilter[14].color,
      foot: kilter[15].color,
    });
  });

  it('--radius-tray matches theme-config', () => {
    expect(rootVars['--radius-tray']).toBe(`${themeTokens.marketing.radiusTray}px`);
  });

  it('every role clears 3:1 as a decorative glyph on every Graphite surface', () => {
    const surfaces = [
      themeTokens.semantic.background,
      themeTokens.neutral[50],
      themeTokens.semantic.surface,
      themeTokens.semantic.surfaceElevated,
    ];
    for (const role of Object.values(themeTokens.marketing.lit)) {
      for (const surface of surfaces) expect(contrast(role, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  // Lit colours are glyphs, never ink: a magenta word on #262626 is 4.83:1 as a ring and
  // unreadable as body copy beside it. No stylesheet may set `color:` from one.
  it('no .module.css sets a text colour from a --lit-* token', () => {
    const appRoot = resolve(
      process.cwd(),
      existsSync(resolve(process.cwd(), 'packages/web/app')) ? 'packages/web/app' : 'app',
    );
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.module.css')) {
          const css = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
          if (/(?:^|[\s;{])(?:color|-webkit-text-fill-color)\s*:[^;]*var\(\s*--lit-/m.test(css)) offenders.push(full);
        }
      }
    };
    walk(appRoot);
    expect(offenders).toEqual([]);
  });
});
