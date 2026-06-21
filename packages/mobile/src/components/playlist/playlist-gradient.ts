// Build the playlist-detail hero's colour gradient from a single playlist hex.
// Kept next to `playlist-colors.ts` so the palette stays the one source of truth;
// the small square thumbnail (`PlaylistPreviewSquare`) deliberately does NOT use
// this — the gradient is the detail-hero-only treatment.

import { PLAYLIST_COLORS, isValidHexColor } from './playlist-colors';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(hex: string): string | null {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.replace(/(.)/g, '$1$1') : raw;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) return null;
  return full;
}

function hueToChannel(p: number, q: number, t: number): number {
  let temp = t;
  if (temp < 0) temp += 1;
  if (temp > 1) temp -= 1;
  if (temp < 1 / 6) return p + (q - p) * 6 * temp;
  if (temp < 1 / 2) return q;
  if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
  return p;
}

function hslToHex(hue: number, sat: number, light: number): string {
  let r: number;
  let g: number;
  let b: number;
  if (sat === 0) {
    r = g = b = light;
  } else {
    const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
    const p = 2 * light - q;
    r = hueToChannel(p, q, hue + 1 / 3);
    g = hueToChannel(p, q, hue);
    b = hueToChannel(p, q, hue - 1 / 3);
  }
  const toHex = (channel: number) =>
    Math.round(clamp(channel, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Shift a hex colour's HSL lightness by `deltaPct` percentage points (e.g. +14
 * lifts toward white, -20 deepens), clamped to [0, 100]. Non-hex input is
 * returned unchanged — mirroring `withAlpha` — so a PlatformColor / named colour
 * never produces an invalid value.
 */
export function shiftLightness(hex: string, deltaPct: number): string {
  const full = normalizeHex(hex);
  if (!full) return hex;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  let hue = 0;
  let sat = 0;
  if (max !== min) {
    const delta = max - min;
    sat = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
  }

  return hslToHex(hue, sat, clamp(lightness + deltaPct / 100, 0, 1));
}

export type HeroGradient = {
  colors: readonly [string, string, string];
  locations: readonly [number, number, number];
};

/**
 * A 3-stop diagonal gradient from one playlist colour: a lifted top-left, the
 * true colour through the middle, and a deepened bottom-right (where the title
 * sits, so white text keeps contrast). Falls back to the brand violet when the
 * colour is missing/invalid, so the hero always has a deterministic banner.
 */
export function buildHeroGradient(baseHex: string | undefined): HeroGradient {
  const base = baseHex && isValidHexColor(baseHex) ? baseHex : PLAYLIST_COLORS[0];
  return {
    colors: [shiftLightness(base, 14), base, shiftLightness(base, -20)],
    locations: [0, 0.55, 1],
  };
}
