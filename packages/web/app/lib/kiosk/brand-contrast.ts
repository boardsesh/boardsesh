// Pure, server-safe brand-colour resolution for the kiosk surface.
//
// The kiosk is ALWAYS dark (a TV in a gym), so gym branding only contributes an
// ACCENT colour — never the surface. A gym owner can pick any hex in the manage
// UI, including one that vanishes on a dark screen, so the accent is clamped to
// a minimum contrast ratio against the kiosk surface by mixing it toward white
// until it reads. Runs in server components (no DOM, no React).

import { contrastRatio, readableTextColor } from '@boardsesh/board-constants';

/**
 * The kiosk's dark surface. Mirrors the dark-mode `--semantic-background`
 * token in `app/components/index.css` — kept as a literal here because the
 * contrast math needs a concrete hex at render time, not a CSS var reference.
 */
export const KIOSK_DARK_SURFACE = '#110a20';

/**
 * Accent when the gym set no brand colours (or only invalid ones): the cool
 * near-white brand-primary from the dark theme (`--bs-text-brand-primary`).
 */
export const KIOSK_DEFAULT_ACCENT = '#f5f2fb';

/**
 * WCAG-ish floor for the accent against the dark surface. 3:1 is the
 * large-text/UI-component threshold — kiosk accents decorate large type and
 * chips viewed from metres away, so 3:1 is the right bar (4.5:1 would reject
 * most saturated brand colours outright).
 */
export const KIOSK_MIN_ACCENT_CONTRAST = 3;

export type KioskBrand = {
  /** Brand accent, clamped to ≥3:1 contrast against the dark kiosk surface. */
  accent: string;
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

/** Linear mix of two colours; `whiteAmount` 0 → colour unchanged, 1 → white. */
function mixTowardWhite(color: RgbColor, whiteAmount: number): RgbColor {
  return {
    red: color.red + (255 - color.red) * whiteAmount,
    green: color.green + (255 - color.green) * whiteAmount,
    blue: color.blue + (255 - color.blue) * whiteAmount,
  };
}

/**
 * Lighten `color` (by mixing toward white in 5% steps) until it reaches
 * `minRatio` contrast against `surface`. A colour that already passes is
 * returned unchanged (normalised to `#rrggbb`). White always passes against a
 * dark surface, so the loop terminates. Invalid input returns `null` — the
 * caller decides the fallback.
 */
export function ensureReadableOnSurface(color: string, surface: string, minRatio: number): string | null {
  const parsedColor = parseHexColor(color);
  if (parsedColor === null) return null;

  for (let whiteAmount = 0; whiteAmount <= 1; whiteAmount += 0.05) {
    const candidate = toHexColor(mixTowardWhite(parsedColor, whiteAmount));
    const ratio = contrastRatio(candidate, surface);
    if (ratio !== null && ratio >= minRatio) {
      return candidate;
    }
  }
  return '#ffffff';
}

/**
 * Resolve the kiosk brand from gym branding fields. Accent preference:
 * `brandAccentColor`, then `brandPrimaryColor`, then the Boardsesh default —
 * each clamped to ≥3:1 against the dark surface. `brandBackgroundColor` is
 * deliberately ignored: the kiosk surface stays dark regardless of branding.
 */
export function resolveKioskBrand(gym: {
  brandAccentColor?: string | null;
  brandPrimaryColor?: string | null;
}): KioskBrand {
  const candidates = [gym.brandAccentColor, gym.brandPrimaryColor, KIOSK_DEFAULT_ACCENT];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const accent = ensureReadableOnSurface(candidate, KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST);
    if (accent !== null) {
      return { accent, onAccent: readableTextColor(accent) };
    }
  }
  // Unreachable in practice (the default accent always parses), but keeps the
  // function total without a non-null assertion.
  return { accent: KIOSK_DEFAULT_ACCENT, onAccent: readableTextColor(KIOSK_DEFAULT_ACCENT) };
}
