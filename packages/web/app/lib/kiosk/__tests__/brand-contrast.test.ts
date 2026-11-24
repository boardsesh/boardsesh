import { describe, expect, it } from 'vitest';
import { contrastRatio, readableDarkText, readableLightText } from '@boardsesh/board-constants';
import { KIOSK_THEMES } from '@boardsesh/kiosk';
import {
  KIOSK_DARK_SURFACE,
  KIOSK_DEFAULT_ACCENT,
  KIOSK_LIGHT_SURFACE,
  KIOSK_MIN_ACCENT_CONTRAST,
  KIOSK_MIN_TEXT_CONTRAST,
  ensureReadableOnSurface,
  resolveKioskBrand,
  resolveKioskPalette,
} from '../brand-contrast';

describe('ensureReadableOnSurface', () => {
  it('returns an already-readable colour unchanged (normalised to #rrggbb)', () => {
    expect(ensureReadableOnSurface('#F5F2FB', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST)).toBe('#f5f2fb');
  });

  it('expands 3-digit hex', () => {
    expect(ensureReadableOnSurface('#fff', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST)).toBe('#ffffff');
  });

  it('lightens a too-dark accent until it clears the contrast floor', () => {
    // A deep navy is unreadable on the dark kiosk surface as-is.
    const original = '#1a1a5e';
    expect(contrastRatio(original, KIOSK_DARK_SURFACE)!).toBeLessThan(KIOSK_MIN_ACCENT_CONTRAST);

    const clamped = ensureReadableOnSurface(original, KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST);
    expect(clamped).not.toBeNull();
    expect(contrastRatio(clamped!, KIOSK_DARK_SURFACE)!).toBeGreaterThanOrEqual(KIOSK_MIN_ACCENT_CONTRAST);
  });

  it('even pure black resolves to something readable', () => {
    const clamped = ensureReadableOnSurface('#000000', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST);
    expect(clamped).not.toBeNull();
    expect(contrastRatio(clamped!, KIOSK_DARK_SURFACE)!).toBeGreaterThanOrEqual(KIOSK_MIN_ACCENT_CONTRAST);
  });

  it('returns null for garbage input', () => {
    expect(ensureReadableOnSurface('tomato', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST)).toBeNull();
    expect(ensureReadableOnSurface('#12345', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST)).toBeNull();
    expect(ensureReadableOnSurface('', KIOSK_DARK_SURFACE, KIOSK_MIN_ACCENT_CONTRAST)).toBeNull();
  });

  it('darkens a pale accent on white rather than lightening it', () => {
    const resolved = ensureReadableOnSurface('#FDCF07', KIOSK_LIGHT_SURFACE, KIOSK_MIN_TEXT_CONTRAST);
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe('#fdcf07');
    expect(contrastRatio(resolved!, KIOSK_LIGHT_SURFACE)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
  });
});

describe.each(KIOSK_THEMES)('%s kiosk palette', (theme) => {
  const palette = resolveKioskPalette(theme);

  it.each(['#FDCF07', '#4A778D', '#FFFFFF', '#000000', '#777777', '#ff0000'])(
    'keeps brand fill, ordinary text and on-accent text readable for %s',
    (accent) => {
      const brand = resolveKioskBrand({ brandAccentColor: accent }, theme);
      for (const surface of [palette.surface, palette.raised]) {
        expect(contrastRatio(brand.accent, surface)).toBeGreaterThanOrEqual(KIOSK_MIN_ACCENT_CONTRAST);
        expect(contrastRatio(brand.accentText, surface)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
        expect(contrastRatio(palette.text, surface)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
        expect(contrastRatio(palette.muted, surface)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
      }
      expect(contrastRatio(brand.onAccent, brand.accent)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
    },
  );

  it('keeps the reconnect warning readable independently of the surface', () => {
    expect(contrastRatio(palette.onWarning, palette.warning)).toBeGreaterThanOrEqual(KIOSK_MIN_TEXT_CONTRAST);
  });

  it('uses the selected palette for missing or malformed gym colours', () => {
    const fallback = resolveKioskBrand({ brandAccentColor: 'invalid' }, theme);
    expect(fallback.accent).toBe(palette.text.toLowerCase());
    expect(resolveKioskBrand({}, theme)).toEqual(fallback);
  });
});

describe('resolveKioskBrand', () => {
  it('prefers the accent colour over the primary colour', () => {
    const brand = resolveKioskBrand({ brandAccentColor: '#7cd6c4', brandPrimaryColor: '#ffffff' });
    expect(brand.accent).toBe('#7cd6c4');
  });

  it('falls back to the primary colour when no accent is set', () => {
    const brand = resolveKioskBrand({ brandAccentColor: null, brandPrimaryColor: '#ffffff' });
    expect(brand.accent).toBe('#ffffff');
  });

  it('falls back to the default accent when no branding is set', () => {
    const brand = resolveKioskBrand({});
    expect(brand.accent).toBe(KIOSK_DEFAULT_ACCENT.toLowerCase());
  });

  it('skips an invalid accent and uses the next candidate', () => {
    const brand = resolveKioskBrand({ brandAccentColor: 'not-a-colour', brandPrimaryColor: '#ffffff' });
    expect(brand.accent).toBe('#ffffff');
  });

  it('clamps every resolved accent to the contrast floor', () => {
    const brand = resolveKioskBrand({ brandAccentColor: '#111111' });
    expect(contrastRatio(brand.accent, KIOSK_DARK_SURFACE)!).toBeGreaterThanOrEqual(KIOSK_MIN_ACCENT_CONTRAST);
  });

  it('derives a readable on-accent text colour', () => {
    const lightAccent = resolveKioskBrand({ brandAccentColor: KIOSK_DEFAULT_ACCENT });
    expect(lightAccent.onAccent).toBe(readableDarkText);

    const midAccent = resolveKioskBrand({ brandAccentColor: '#3d6b8c' });
    expect([readableDarkText, readableLightText]).toContain(midAccent.onAccent);
    expect(contrastRatio(midAccent.onAccent, midAccent.accent)!).toBeGreaterThan(1);
  });
});
