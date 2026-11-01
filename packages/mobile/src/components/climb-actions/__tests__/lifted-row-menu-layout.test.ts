import { describe, expect, it } from 'vitest';
import {
  getLiftedRowMenuLayout,
  type MenuAnchorRect,
  type MenuInsets,
  type MenuViewport,
} from '../lifted-row-menu-layout';

const viewport: MenuViewport = { width: 402, height: 874 };
const insets: MenuInsets = { top: 62, bottom: 34, left: 0, right: 0 };
const anchor: MenuAnchorRect = { x: 16, y: 120, width: 326, height: 96 };

describe('lifted climb row menu layout', () => {
  it('keeps a normally sized row in place and puts the menu directly below it', () => {
    expect(getLiftedRowMenuLayout({ anchor, viewport, insets, menuHeight: 500 })).toEqual({
      preview: { left: 16, top: 120, width: 326, height: 96 },
      menu: { left: 16, top: 226, width: 280, maxHeight: 500 },
    });
  });

  it('lifts a bottom row and its menu together above the home indicator', () => {
    const layout = getLiftedRowMenuLayout({ anchor: { ...anchor, y: 750 }, viewport, insets, menuHeight: 500 });
    expect(layout.preview.top).toBe(226);
    expect(layout.menu.top).toBe(332);
    expect(layout.menu.top + layout.menu.maxHeight).toBe(832);
  });

  it('brings a partly scrolled row below the top safe area', () => {
    const layout = getLiftedRowMenuLayout({ anchor: { ...anchor, y: -100 }, viewport, insets, menuHeight: 500 });
    expect(layout.preview.top).toBe(70);
    expect(layout.menu.top).toBe(176);
  });

  it('makes a long action list scroll without shrinking a normal preview', () => {
    const layout = getLiftedRowMenuLayout({ anchor, viewport, insets, menuHeight: 10_000 });
    expect(layout.preview).toEqual({ left: 16, top: 70, width: 326, height: 96 });
    expect(layout.menu).toEqual({ left: 16, top: 176, width: 280, maxHeight: 656 });
  });

  it('fits landscape safe areas while reserving room for scrolling actions', () => {
    const layout = getLiftedRowMenuLayout({
      anchor: { x: 100, y: 240, width: 640, height: 96 },
      viewport: { width: 874, height: 402 },
      insets: { top: 0, bottom: 21, left: 62, right: 62 },
      menuHeight: 600,
    });
    expect(layout.preview).toEqual({ left: 100, top: 8, width: 640, height: 96 });
    expect(layout.menu).toEqual({ left: 100, top: 114, width: 280, maxHeight: 259 });
  });

  it('bounds both widths on a narrow screen and clamps a right-edge anchor', () => {
    const layout = getLiftedRowMenuLayout({
      anchor: { x: 210, y: 100, width: 500, height: 60 },
      viewport: { width: 240, height: 568 },
      insets: { top: 20, bottom: 0, left: 0, right: 0 },
      menuHeight: 300,
    });
    expect(layout.preview).toEqual({ left: 16, top: 100, width: 208, height: 60 });
    expect(layout.menu).toEqual({ left: 16, top: 170, width: 208, maxHeight: 300 });
  });

  it('keeps an iPad preview within side insets without stretching its menu', () => {
    const layout = getLiftedRowMenuLayout({
      anchor: { x: 0, y: 300, width: 1500, height: 120 },
      viewport: { width: 1024, height: 1366 },
      insets: { top: 24, bottom: 20, left: 44, right: 44 },
      menuHeight: 500,
    });
    expect(layout.preview).toEqual({ left: 60, top: 300, width: 904, height: 120 });
    expect(layout.menu).toEqual({ left: 60, top: 430, width: 280, maxHeight: 500 });
  });

  it('reserves one action target when the source row itself is taller than the screen', () => {
    const layout = getLiftedRowMenuLayout({ anchor: { ...anchor, height: 1000 }, viewport, insets, menuHeight: 500 });
    expect(layout.preview.height).toBe(708);
    expect(layout.menu.maxHeight).toBe(44);
    expect(layout.menu.top + layout.menu.maxHeight).toBe(832);
  });

  it('returns collapsed finite bounds for a zero viewport', () => {
    expect(getLiftedRowMenuLayout({ anchor, viewport: { width: 0, height: 0 }, insets, menuHeight: 500 })).toEqual({
      preview: { left: 0, top: 0, width: 0, height: 0 },
      menu: { left: 0, top: 0, width: 0, maxHeight: 0 },
    });
  });

  it('reduces gutters before producing negative space in a tiny window', () => {
    expect(
      getLiftedRowMenuLayout({
        anchor,
        viewport: { width: 12, height: 12 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
        menuHeight: 500,
      }),
    ).toEqual({
      preview: { left: 6, top: 6, width: 0, height: 0 },
      menu: { left: 6, top: 6, width: 0, maxHeight: 0 },
    });
  });

  it('clamps oversized safe insets to the viewport', () => {
    expect(
      getLiftedRowMenuLayout({
        anchor,
        viewport,
        insets: { top: 10_000, bottom: 10_000, left: 10_000, right: 10_000 },
        menuHeight: 500,
      }),
    ).toEqual({
      preview: { left: 402, top: 874, width: 0, height: 0 },
      menu: { left: 402, top: 874, width: 0, maxHeight: 0 },
    });
  });

  it('clamps a wider custom menu without moving the source row horizontally', () => {
    const layout = getLiftedRowMenuLayout({
      anchor: { x: 250, y: 120, width: 100, height: 96 },
      viewport,
      insets,
      menuHeight: 200,
      menuWidth: 320,
    });
    expect(layout.preview.left).toBe(250);
    expect(layout.menu).toEqual({ left: 66, top: 226, width: 320, maxHeight: 200 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -100])(
    'collapses malformed viewport dimensions %s',
    (invalidDimension) => {
      expect(
        getLiftedRowMenuLayout({
          anchor,
          viewport: { width: invalidDimension, height: invalidDimension },
          insets,
          menuHeight: 500,
        }),
      ).toEqual({
        preview: { left: 0, top: 0, width: 0, height: 0 },
        menu: { left: 0, top: 0, width: 0, maxHeight: 0 },
      });
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -100, 0])(
    'keeps malformed dimensions %s finite and nonnegative',
    (invalidDimension) => {
      const layout = getLiftedRowMenuLayout({
        anchor: { x: invalidDimension, y: invalidDimension, width: invalidDimension, height: invalidDimension },
        viewport,
        insets: { top: invalidDimension, bottom: invalidDimension, left: invalidDimension, right: invalidDimension },
        menuHeight: invalidDimension,
        menuWidth: invalidDimension,
      });
      for (const position of [...Object.values(layout.preview), ...Object.values(layout.menu)]) {
        expect(Number.isFinite(position)).toBe(true);
        expect(position).toBeGreaterThanOrEqual(0);
      }
      expect(layout.preview.left + layout.preview.width).toBeLessThanOrEqual(viewport.width);
      expect(layout.preview.top + layout.preview.height).toBeLessThanOrEqual(viewport.height);
      expect(layout.menu.left + layout.menu.width).toBeLessThanOrEqual(viewport.width);
      expect(layout.menu.top + layout.menu.maxHeight).toBeLessThanOrEqual(viewport.height);
    },
  );
});
