import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
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
    ['--color-info', themeTokens.colors.info, darkTokens.colors.info],
    ['--color-success', themeTokens.colors.success, darkTokens.colors.success],
    ['--color-error', themeTokens.colors.error, darkTokens.colors.error],
    ['--color-warning', themeTokens.colors.warning, darkTokens.colors.warning],
    ['--color-error-muted', themeTokens.colors.errorMuted, darkTokens.colors.errorMuted],
    ['--semantic-background', themeTokens.semantic.background, darkTokens.semantic.background],
    ['--semantic-surface', themeTokens.semantic.surface, darkTokens.semantic.surface],
    ['--semantic-selected-border', themeTokens.semantic.selectedBorder, darkTokens.semantic.selectedBorder],
    ['--separator', themeTokens.semantic.separator, darkTokens.semantic.separator],
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

  it('the dark focus ring (fill violet) clears the 3:1 UI floor on the white dark-mode input', () => {
    expect(contrast(darkTokens.colors.primaryFill, '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('secondary text clears AA on its surface (both schemes)', () => {
    expect(contrast(themeTokens.neutral[500], themeTokens.semantic.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkTokens.neutral[500], darkTokens.semantic.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
