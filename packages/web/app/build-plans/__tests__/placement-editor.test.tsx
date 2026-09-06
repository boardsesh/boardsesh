import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CncArtworkRules } from '@boardsesh/shared-schema';
import type { CncArtworkDraft } from '../configurator/configurator-state';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

/**
 * The editor as a buyer meets it: a wall with holes on it, a label they drag.
 *
 * The maths is covered in `geometry.test.ts` and `placement-reducer.test.ts`;
 * what is worth checking here is the wiring between them and the DOM — that the
 * layout response reaches the picture, that a pointer drag lands as millimetres
 * on the item, and that the same is reachable from a keyboard.
 */

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const { readLayoutModel } = await import('../configurator/layout-model');
const PlacementEditor = (await import('../configurator/placement-editor/placement-editor')).default;

/** A two-panel wall, in the generator's own snake_case shape. */
const RAW_LAYOUT = {
  schema_version: 1,
  units: 'mm',
  wall: { width_mm: 2400, height_mm: 1200, kicker_height_mm: 0, grid_pitch_mm: 100 },
  panels: [
    { index: 0, id: 'R1C1', role: 'main', x_mm: 0, y_mm: 0, width_mm: 1200, height_mm: 1200 },
    { index: 1, id: 'R1C2', role: 'main', x_mm: 1200, y_mm: 0, width_mm: 1200, height_mm: 1200 },
  ],
  seams: [{ kind: 'vertical', x_mm: 1200, extent: [0, 1200], between: [0, 1] }],
  holes: [
    { panel_index: 0, set_id: 26, kind: 'tnut', x_mm: 300, y_mm: 300, diameter_mm: 12.5, keepout_radius_mm: 26 },
    { panel_index: 0, set_id: 26, kind: 'led', x_mm: 900, y_mm: 900, diameter_mm: 12.5, keepout_radius_mm: 11 },
    { panel_index: 1, set_id: 26, kind: 'tnut', x_mm: 1500, y_mm: 300, diameter_mm: 12.5, keepout_radius_mm: 26 },
  ],
  keepout: {
    tnut_radius_mm: 6.25,
    led_radius_mm: 6.25,
    panel_edge_margin_mm: 15,
    seam_clearance_mm: 10,
    cut_through_multiplier: 1.5,
  },
};

const RULES: CncArtworkRules = {
  maxItems: 4,
  minWidthMm: 40,
  maxWidthMm: 1200,
  maxTextChars: 40,
  allowedKinds: ['text', 'svg'],
};

/** The canvas viewBox for this wall: the wall plus 120 mm of padding all round. */
const VIEW_BOX = { widthMm: 2640, heightMm: 1440, minXMm: -120, minYMm: -1320 };

/** Wall millimetres to the client coordinates a pointer event carries, at 1 px per mm. */
function clientFromWall(xMm: number, yMm: number): { clientX: number; clientY: number } {
  return { clientX: xMm - VIEW_BOX.minXMm, clientY: -yMm - VIEW_BOX.minYMm };
}

function item(): CncArtworkDraft {
  return {
    id: 'label-1',
    kind: 'text',
    assetId: null,
    text: 'BOARDSESH',
    font: 'liberation-sans',
    mode: 'engrave' as const,
    panelIndex: 0,
    xMm: 600,
    yMm: 600,
    widthMm: 100,
    rotationDeg: 0,
  };
}

function renderEditor(onChange = vi.fn(), onLocalCollisions = vi.fn()) {
  const layout = readLayoutModel(RAW_LAYOUT);
  const view = render(
    <PlacementEditor
      item={item()}
      panels={layout.panels}
      panelRects={layout.panelRects}
      holes={layout.holes}
      holePanelIndex={layout.holePanelIndex}
      seams={layout.seams}
      keepout={layout.keepout}
      wall={layout.wall}
      rules={RULES}
      onChange={onChange}
      onLocalCollisions={onLocalCollisions}
    />,
  );
  return { ...view, onChange, onLocalCollisions };
}

/** The last placement the editor pushed up. */
function lastPlacement(onChange: ReturnType<typeof vi.fn>): Record<string, number> {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1][0] as Record<string, number>;
}

beforeEach(() => {
  // jsdom lays nothing out, so the canvas would measure zero and every pointer
  // would land in the middle of the wall. Pinning the box to the viewBox makes
  // one CSS pixel one millimetre, which is what the maths above assumes.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: VIEW_BOX.widthMm,
    bottom: VIEW_BOX.heightMm,
    width: VIEW_BOX.widthMm,
    height: VIEW_BOX.heightMm,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the placement editor', () => {
  it('draws the wall it was given, with the holes of the selected panel', () => {
    const { container } = renderEditor();
    expect(screen.getByRole('application')).toBeDefined();
    // Two panels, and only panel 0's two holes: the other panel's grid is not
    // reachable from here and would only be noise.
    expect(container.querySelectorAll('rect').length).toBe(3);
    expect(screen.getAllByTestId('cnc-hole').length).toBe(2);
  });

  it('moves the label to where the pointer dragged it, in snapped millimetres', () => {
    const { onChange } = renderEditor();
    const art = screen.getByTestId('cnc-art');

    fireEvent.pointerDown(art, { pointerId: 1, ...clientFromWall(600, 600) });
    fireEvent.pointerMove(screen.getByRole('application'), { pointerId: 1, ...clientFromWall(803, 600) });
    fireEvent.pointerUp(screen.getByRole('application'), { pointerId: 1 });

    expect(lastPlacement(onChange)).toMatchObject({ panelIndex: 0, xMm: 800, yMm: 600 });
  });

  it('nudges with the arrow keys', () => {
    const { onChange } = renderEditor();
    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowUp' });
    expect(lastPlacement(onChange)).toMatchObject({ xMm: 600, yMm: 610 });

    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowLeft', shiftKey: true });
    expect(lastPlacement(onChange)).toMatchObject({ xMm: 599, yMm: 610 });
  });

  it('reports a label dragged onto a hole, so checkout can stay shut', () => {
    const { onLocalCollisions } = renderEditor();
    expect(onLocalCollisions).toHaveBeenLastCalledWith(false);

    const art = screen.getByTestId('cnc-art');
    fireEvent.pointerDown(art, { pointerId: 1, ...clientFromWall(600, 600) });
    fireEvent.pointerMove(screen.getByRole('application'), { pointerId: 1, ...clientFromWall(300, 300) });

    expect(onLocalCollisions).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/lands on 1 hole/)).toBeDefined();
  });
});
