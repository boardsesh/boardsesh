// Pure, server-safe brand-colour resolution for the kiosk surface.
//
// Each kiosk chooses its own light/dark palette. Gym branding contributes the
// accent; contrast is checked against both the page and panel surfaces.

import { contrastRatio, readableTextColor } from '@boardsesh/board-constants';
import { KIOSK_DEFAULT_THEME, type KioskTheme } from '@boardsesh/kiosk';
import { brandColors, brandColorsDark, materialSurfaces, withAlpha } from '@boardsesh/velvet-tokens';

/**
 * The kiosk's dark surface. Mirrors the dark-mode `--semantic-background`
 * token in `app/components/index.css` — kept as a literal here because the
 * contrast math needs a concrete hex at render time, not a CSS var reference.
 */
export const KIOSK_DARK_SURFACE: string = materialSurfaces.dark.background;
export const KIOSK_LIGHT_SURFACE: string = materialSurfaces.light.secondaryBackground;

/** Shared by the server-rendered kiosk and the editor's preview frame. */
export function resolveKioskPalette(theme: KioskTheme = KIOSK_DEFAULT_THEME) {
  const surfaces = materialSurfaces[theme];
  const surface = theme === 'light' ? KIOSK_LIGHT_SURFACE : KIOSK_DARK_SURFACE;
  const raised = theme === 'light' ? surfaces.background : surfaces.secondaryBackground;
  const warning = (theme === 'light' ? brandColors : brandColorsDark).warning;
  return {
    surface,
    raised,
    text: surfaces.label,
    muted: surfaces.secondaryLabel,
    border: surfaces.separator,
    overlay: withAlpha(raised, 0.96),
    warning,
    onWarning: readableTextColor(warning),
  };
}

/**
 * Accent when the gym set no brand colours (or only invalid ones): the dark
 * theme label colour (`--neutral-900`, Graphite #EDEDED).
 */
export const KIOSK_DEFAULT_ACCENT: string = materialSurfaces.dark.label;

/**
 * WCAG-ish floor for the accent against the dark surface. 3:1 is the
 * large-text/UI-component threshold — kiosk accents decorate large type and
 * chips viewed from metres away, so 3:1 is the right bar (4.5:1 would reject
 * most saturated brand colours outright).
 */
export const KIOSK_MIN_ACCENT_CONTRAST = 3;
export const KIOSK_MIN_TEXT_CONTRAST = 4.5;

export type KioskBrand = {
  /** Brand fill, clamped to ≥3:1 against both theme surfaces. */
  accent: string;
  /** Accent used for ordinary text, clamped to ≥4.5:1 on both surfaces. */
  accentText: string;
  /** Readable text colour (#000000 or #FFFFFF) for content ON the accent. */
  onAccent: string;
};

type RgbColor = { red: number; green: number; blue: number };

function parseHexColor(value: string): RgbColor | null {
  const raw = value.trim().replace('#', '');
  const expanded = /^[0-9a-fA-F]{3}$/.test(raw) ? raw.replace(/(.)/g, '$1$1') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  return {
    red: parseInt(expanded.slice(0, 2), 16),
    green: parseInt(expanded.slice(2, 4), 16),
    blue: parseInt(expanded.slice(4, 6), 16),
  };
}

function toHexColor({ red, green, blue }: RgbColor): string {
  const channelToHex = (channel: number) =>
    Math.round(Math.min(255, Math.max(0, channel)))
      .toString(16)
      .padStart(2, '0');
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`;
}

/** Mix towards the black/white endpoint that contrasts with the surfaces. */
function mixTowardEndpoint(color: RgbColor, endpoint: number, amount: number): RgbColor {
  return {
    red: color.red + (endpoint - color.red) * amount,
    green: color.green + (endpoint - color.green) * amount,
    blue: color.blue + (endpoint - color.blue) * amount,
  };
}

function ensureReadableOnSurfaces(color: string, surfaces: string[], minRatio: number): string | null {
  const parsedColor = parseHexColor(color);
  if (parsedColor === null) return null;

  const minimumContrast = (candidate: string) =>
    Math.min(...surfaces.map((surface) => contrastRatio(candidate, surface) ?? 0));
  const endpoint = minimumContrast('#000000') > minimumContrast('#ffffff') ? 0 : 255;
  for (let step = 0; step <= 20; step += 1) {
    const candidate = toHexColor(mixTowardEndpoint(parsedColor, endpoint, step / 20));
    if (minimumContrast(candidate) >= minRatio) {
      return candidate;
    }
  }
  return null;
}

/** Preserve readable colours; lighten on dark surfaces and darken on light. */
export function ensureReadableOnSurface(color: string, surface: string, minRatio: number): string | null {
  return ensureReadableOnSurfaces(color, [surface], minRatio);
}

/**
 * Resolve the kiosk brand from gym branding fields. Accent preference:
 * `brandAccentColor`, then `brandPrimaryColor`, then the Boardsesh default —
 * each adjusted against the selected kiosk palette. The gym-level
 * `brandBackgroundColor` remains separate from this per-kiosk setting.
 */
export function resolveKioskBrand(
  gym: { brandAccentColor?: string | null; brandPrimaryColor?: string | null },
  theme: KioskTheme = KIOSK_DEFAULT_THEME,
): KioskBrand {
  const palette = resolveKioskPalette(theme);
  const surfaces = [palette.surface, palette.raised];
  const candidates = [gym.brandAccentColor, gym.brandPrimaryColor, palette.text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const accent = ensureReadableOnSurfaces(candidate, surfaces, KIOSK_MIN_ACCENT_CONTRAST);
    const accentText = ensureReadableOnSurfaces(candidate, surfaces, KIOSK_MIN_TEXT_CONTRAST);
    if (accent !== null && accentText !== null) {
      return { accent, accentText, onAccent: readableTextColor(accent) };
    }
  }
  return { accent: palette.text, accentText: palette.text, onAccent: readableTextColor(palette.text) };
}
