import { describe, expect, it, vi } from 'vitest';

// `theme/layout` can reach modules that import react-native, Flow source the
// node env can't parse. Nothing here reads it beyond module scope.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
}));

import { textStylesByVariant } from '../typography';
import { topBarByVariant, topBarFor } from '../top-bar';
import { resolveTopBarActionLook, type TopBarActionColors } from '../../components/top-bar-action-look';

const colors: TopBarActionColors = { label: 'label', primary: 'brand', onPrimary: 'white', error: 'red' };

describe('the label text variant', () => {
  it('is the iOS bar-item size on Liquid Glass: 17/22 regular', () => {
    expect(textStylesByVariant.liquidGlass.label).toEqual({ fontSize: 17, fontWeight: '400', lineHeight: 22 });
  });

  it('is M3 labelLarge on Material: 14/20 medium', () => {
    expect(textStylesByVariant.material.label).toEqual({ fontSize: 14, fontWeight: '500', lineHeight: 20 });
  });
});

describe('topBarByVariant', () => {
  it('Liquid Glass: a 17pt glyph in a 44pt target, a 36pt confirm capsule, bar labels that do not scale', () => {
    const spec = topBarByVariant.liquidGlass;
    expect(spec).toMatchObject({
      iconTarget: 44,
      glyphSize: 17,
      navigationGlyphColor: 'label',
      actionGlyphColor: 'label',
      glyphFilled: true,
      labelMaxFontScale: 1,
      prominentFilled: true,
      confirmHeight: 36,
      confirmPaddingHorizontal: 14,
      prominentFontWeight: '600',
      disabledOpacity: 0.4,
    });
  });

  it('Material: a 24dp glyph in a 48dp target (onSurface to navigate, onSurfaceVariant for actions), no fill, labels capped at 1.2x', () => {
    const spec = topBarByVariant.material;
    expect(spec).toMatchObject({
      iconTarget: 48,
      glyphSize: 24,
      navigationGlyphColor: 'label',
      actionGlyphColor: 'secondaryLabel',
      glyphFilled: false,
      labelMaxFontScale: 1.2,
      prominentFilled: false,
      prominentFontWeight: '500',
      disabledOpacity: 0.38,
      disabledInLabelColor: true,
    });
  });

  it('every target is at or above the platform touch floor', () => {
    expect(topBarByVariant.liquidGlass.iconTarget).toBeGreaterThanOrEqual(44);
    expect(topBarByVariant.material.iconTarget).toBeGreaterThanOrEqual(48);
  });

  it('topBarFor falls back to Liquid Glass when a theme carries no variant', () => {
    expect(topBarFor(undefined)).toBe(topBarByVariant.liquidGlass);
    expect(topBarFor('material')).toBe(topBarByVariant.material);
  });
});

describe('resolveTopBarActionLook', () => {
  const glass = topBarByVariant.liquidGlass;
  const material = topBarByVariant.material;

  it('a prominent forward action in a sheet on Liquid Glass is a brand capsule with onPrimary 600 text', () => {
    expect(resolveTopBarActionLook(glass, colors, { kind: 'forward', prominent: true, surface: 'sheet' })).toEqual({
      glyph: undefined,
      filled: true,
      fillColor: 'brand',
      labelColor: 'white',
      fontWeight: '600',
      opacity: 1,
    });
  });

  it('inside UIKit’s shared glass a confirm is brand 600 text: no circle or capsule in a capsule', () => {
    for (const input of [{ prominent: true }, { kind: 'confirm' as const }]) {
      expect(resolveTopBarActionLook(glass, colors, { ...input, surface: 'nativeHeader' })).toMatchObject({
        glyph: undefined,
        filled: false,
        labelColor: 'brand',
        fontWeight: '600',
      });
    }
  });

  it('an iOS 26 standalone bar item draws the same ✓ circle a sheet does', () => {
    expect(resolveTopBarActionLook(glass, colors, { kind: 'confirm', surface: 'standaloneBarItem' })).toMatchObject({
      glyph: 'confirm',
      fillColor: 'brand',
    });
  });

  it('a confirm in a sheet is the ✓ on Liquid Glass; a send is prominent text, never the ✓', () => {
    expect(resolveTopBarActionLook(glass, colors, { kind: 'confirm', surface: 'sheet' }).glyph).toBe('confirm');
    expect(resolveTopBarActionLook(glass, colors, { kind: 'send', surface: 'sheet' })).toMatchObject({
      glyph: undefined,
      filled: true,
      fontWeight: '600',
    });
  });

  it('no red ✓: a destructive confirm is red semibold text with no fill', () => {
    expect(resolveTopBarActionLook(glass, colors, { kind: 'confirm', destructive: true, surface: 'sheet' })).toEqual({
      glyph: undefined,
      filled: false,
      fillColor: undefined,
      labelColor: 'red',
      fontWeight: '600',
      opacity: 1,
    });
  });

  it('a plain action is in the label colour: brand is for the prominent confirm alone', () => {
    for (const spec of [glass, material]) {
      for (const surface of ['sheet', 'nativeHeader'] as const) {
        expect(resolveTopBarActionLook(spec, colors, { surface })).toMatchObject({
          filled: false,
          labelColor: 'label',
          fontWeight: undefined,
        });
      }
    }
  });

  it('Material: the confirm is brand 500 text with no fill', () => {
    expect(resolveTopBarActionLook(material, colors, { prominent: true, surface: 'sheet' })).toMatchObject({
      filled: false,
      labelColor: 'brand',
      fontWeight: '500',
    });
  });

  it('a destructive action takes the error colour', () => {
    expect(
      resolveTopBarActionLook(glass, colors, { prominent: true, destructive: true, surface: 'sheet' }).labelColor,
    ).toBe('red');
    expect(resolveTopBarActionLook(material, colors, { destructive: true, surface: 'sheet' }).labelColor).toBe('red');
  });

  it('disabled: 40% on iOS keeping its colour; onSurface at 38% on Material', () => {
    expect(
      resolveTopBarActionLook(glass, colors, { prominent: true, disabled: true, surface: 'nativeHeader' }),
    ).toMatchObject({ labelColor: 'brand', opacity: 0.4 });
    expect(
      resolveTopBarActionLook(material, colors, { prominent: true, disabled: true, surface: 'sheet' }),
    ).toMatchObject({ labelColor: 'label', opacity: 0.38 });
  });
});
