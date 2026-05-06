import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type {
  BoardDetails,
  HoldFilterMode,
  HoldFilterType,
  HoldsFilter,
  SearchRequestPagination,
  ZoneBox,
} from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { gridToSvg, svgToGrid, type BoardDimensions } from '../climb-zone-math';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const mockUpdateFilters = vi.fn();
let mockUISearchParams: SearchRequestPagination = { ...DEFAULT_SEARCH_PARAMS };

vi.mock('@/app/components/queue-control/ui-searchparams-provider', () => ({
  useUISearchParams: () => ({
    uiSearchParams: mockUISearchParams,
    updateFilters: mockUpdateFilters,
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/kilter/1/1/1/40/list',
}));

vi.mock('@/app/lib/analytics', () => ({
  track: vi.fn(),
}));

vi.mock('../../board-renderer/board-renderer', () => ({
  default: () => null,
}));

vi.mock('../../create-climb/hold-type-picker', () => ({
  default: () => null,
}));

vi.mock('../../create-climb/create-climb-heatmap-overlay', () => ({
  default: () => null,
}));

vi.mock('../search-hold-filter-overlay', () => ({
  default: () => null,
}));

// Capture the `setHoldFilter` callback the form passes into useSearchHoldPicker
// so tests can simulate a hold tap by invoking it directly. Doing it through
// picker.handleHoldClick would require routing through the popover (mocked to
// null), so we shortcut by talking to the form's setter.
type CapturedSetHoldFilter = (holdId: number, type: HoldFilterType, nextMode: HoldFilterMode | undefined) => void;
let capturedSetHoldFilter: CapturedSetHoldFilter | null = null;

vi.mock('../use-search-hold-picker', () => ({
  useSearchHoldPicker: (options: { setHoldFilter: CapturedSetHoldFilter }) => {
    capturedSetHoldFilter = options.setHoldFilter;
    return {
      anchorEl: null,
      activeHoldId: null,
      currentEntry: {},
      handleHoldClick: vi.fn(),
      handleFilterChange: vi.fn(),
      handleClearAll: vi.fn(),
      handleClose: vi.fn(),
    };
  },
}));

import ClimbSearchForm from '../climb-search-form';

// 144 x 156 grid mapped to 1080 x 1170 px — same dims used elsewhere in the
// search-drawer tests so the math results are predictable.
const dims: BoardDimensions = {
  boardWidth: 1080,
  boardHeight: 1170,
  edgeLeft: 0,
  edgeRight: 144,
  edgeBottom: 0,
  edgeTop: 156,
};

const holdAtGrid = (id: number, gridX: number, gridY: number) => {
  const svgPoint = gridToSvg(gridX, gridY, dims);
  return { id, mirroredHoldId: null, cx: svgPoint.x, cy: svgPoint.y, r: 30 };
};

// Three filter-holds: one inside the default 60% zone, two outside it (one
// near the bottom-left corner, one near the top-right corner). The default
// zone for these dims is { 29, 115, 31, 125 } so a hold at (60, 80) is well
// inside, and (10, 10) / (140, 150) are well outside.
const insideHold = holdAtGrid(101, 60, 80);
const outsideBottomLeftHold = holdAtGrid(102, 10, 10);
const outsideTopRightHold = holdAtGrid(103, 140, 150);

const boardDetails = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 1,
  set_ids: [],
  size_name: '12 x 12',
  layout_name: 'Test',
  boardWidth: dims.boardWidth,
  boardHeight: dims.boardHeight,
  edge_left: dims.edgeLeft,
  edge_right: dims.edgeRight,
  edge_bottom: dims.edgeBottom,
  edge_top: dims.edgeTop,
  images_to_holds: {},
  holdsData: [insideHold, outsideBottomLeftHold, outsideTopRightHold],
} as unknown as BoardDetails;

const filterAllThreeHolds: HoldsFilter = {
  101: { STARTING: 'include' },
  102: { ANY: 'include' },
  103: { FOOT: 'exclude' },
};

describe('ClimbSearchForm — zone changes prune out-of-zone holds', () => {
  beforeEach(() => {
    mockUpdateFilters.mockClear();
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
  });

  it('clicking Draw zone keeps only the holds inside the default zone', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, holdsFilter: filterAllThreeHolds };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const drawButton = screen.getByRole('button', { name: 'Draw zone' });
    fireEvent.click(drawButton);

    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
    // Hold 101 (inside the default zone) is preserved; the two outer holds
    // are dropped, since the backend zone filter would never return a climb
    // that uses them anyway.
    expect(lastCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });

  it('clicking Clear zone leaves the holdsFilter untouched', () => {
    const existingZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: { 101: { STARTING: 'include' } },
      zoneBox: existingZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const clearButton = screen.getByRole('button', { name: 'Clear zone' });
    fireEvent.click(clearButton);

    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0];
    // Only zoneBox is cleared; holdsFilter not touched (no zone constraint
    // means hold filters apply on their own).
    expect(lastCall).toEqual({ zoneBox: null });
  });

  it('drops every hold when none of them fit inside the new zone', () => {
    // All three filter holds are outside the default 60% zone (only hold 101
    // would have been inside, so we leave it out here).
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: {
        102: { ANY: 'include' },
        103: { FOOT: 'exclude' },
      },
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: 'Draw zone' }));

    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(lastCall?.holdsFilter).toEqual({});
  });

  it('renders existing zoneBox state from URL params with the Clear button', () => {
    const persistedZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: { 101: { STARTING: 'include' } },
      zoneBox: persistedZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    // Hydrated state: zone is enabled (Clear button visible, Draw not).
    expect(screen.getByRole('button', { name: 'Clear zone' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Draw zone' })).toBeNull();
    // Include chip reflects the persisted holdsFilter.
    expect(screen.getByText('1 included')).toBeTruthy();
  });

  it('renders the selected zone as transparent with dimmed excluded regions', () => {
    const persistedZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: persistedZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const expectAttrs = (testId: string, attrs: Record<string, string>) => {
      const node = screen.getByTestId(testId);
      for (const [name, value] of Object.entries(attrs)) {
        expect(node.getAttribute(name)).toBe(value);
      }
      expect(node.getAttribute('fill')).toBe('#111827');
      expect(node.getAttribute('fill-opacity')).toBe('0.42');
      expect(node.getAttribute('pointer-events')).toBe('none');
    };

    expectAttrs('zone-exclusion-top', { x: '0', y: '0', width: '1080', height: '232.5' });
    expectAttrs('zone-exclusion-bottom', { x: '0', y: '937.5', width: '1080', height: '232.5' });
    expectAttrs('zone-exclusion-left', { x: '0', y: '232.5', width: '217.5', height: '705' });
    expectAttrs('zone-exclusion-right', { x: '862.5', y: '232.5', width: '217.5', height: '705' });

    const outline = screen.getByTestId('zone-selection-outline');
    expect(outline.getAttribute('x')).toBe('217.5');
    expect(outline.getAttribute('y')).toBe('232.5');
    expect(outline.getAttribute('width')).toBe('645');
    expect(outline.getAttribute('height')).toBe('705');
    expect(outline.getAttribute('fill')).toBe('none');
    expect(outline.getAttribute('stroke')).toBe('#8C4A52');
    expect(outline.getAttribute('pointer-events')).toBe('none');
  });

  it('drawing a zone twice (e.g. user clears and redraws) prunes again from current holdsFilter', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, holdsFilter: filterAllThreeHolds };
    const { rerender } = render(<ClimbSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: 'Draw zone' }));
    const firstDraw = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(firstDraw?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });

    // Simulate the URL flushing: provider state now reflects the pruned
    // holdsFilter and the persisted zone. User clears, then draws again.
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: { 101: { STARTING: 'include' } },
      zoneBox: firstDraw!.zoneBox,
    };
    rerender(<ClimbSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear zone' }));

    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: { 101: { STARTING: 'include' } },
      zoneBox: null,
    };
    rerender(<ClimbSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draw zone' }));

    // Second draw still produces a single atomic update. Hold 101 is inside
    // the default zone so it stays.
    const secondDraw = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(secondDraw?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
    expect(secondDraw?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
  });

  it('uses the most recent in-flight holdsFilter when the zone changes mid-debounce', () => {
    // Reproduction of the staleness bug: provider state still reflects an
    // empty filter because the URL update is debounced 500ms, but the
    // user's most recent hold tap has already added hold 101 to the form's
    // internal ref. Drawing a zone right after must respect the in-flight
    // tap, not silently drop it.
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, holdsFilter: {} };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    // Simulate the hold tap. setHoldFilter writes to holdsFilterRef
    // synchronously and calls updateFilters, but we don't update
    // mockUISearchParams here — that's what models the debounce: provider
    // value stays stale until the timer flushes.
    expect(capturedSetHoldFilter).not.toBeNull();
    capturedSetHoldFilter!(101, 'STARTING', 'include');
    expect(mockUpdateFilters).toHaveBeenCalledWith({ holdsFilter: { 101: { STARTING: 'include' } } });
    mockUpdateFilters.mockClear();

    // User immediately clicks Draw zone before the debounce flushes. Hold
    // 101 lives at grid (60, 80) — inside the default 60% zone — so a
    // correctly-implemented prune keeps it. If pruneHoldsToZone had read
    // from the stale uiSearchParams.holdsFilter (still empty), the call
    // would emit holdsFilter: {} and silently drop the just-added hold.
    fireEvent.click(screen.getByRole('button', { name: 'Draw zone' }));
    const drawCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(drawCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
    expect(drawCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
  });
});

describe('ClimbSearchForm — drag handles', () => {
  // JSDOM doesn't implement SVGSVGElement.createSVGPoint or getScreenCTM.
  // svgPointToGrid (in the form) calls both, so simulating pointer events
  // on a real handle requires patching them. The identity-CTM stub makes
  // clientX/clientY equal local SVG coords, so the pointer event coords
  // round-trip cleanly through svgToGrid in the test.
  beforeAll(() => {
    type StubSvgPoint = { x: number; y: number; matrixTransform(matrix: unknown): { x: number; y: number } };
    const proto = SVGSVGElement.prototype as unknown as {
      createSVGPoint?: () => StubSvgPoint;
      getScreenCTM?: () => { inverse(): unknown };
    };
    if (!proto.createSVGPoint) {
      proto.createSVGPoint = function (): StubSvgPoint {
        return {
          x: 0,
          y: 0,
          matrixTransform(_matrix: unknown) {
            return { x: this.x, y: this.y };
          },
        };
      };
    }
    if (!proto.getScreenCTM) {
      proto.getScreenCTM = function () {
        const identity = {
          inverse() {
            return this;
          },
        };
        return identity;
      };
    }
  });

  beforeEach(() => {
    mockUpdateFilters.mockClear();
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
  });

  // Sanity: confirm the SVG-pixel coords used by the drag test correspond
  // to the grid coords we expect, so a future change to gridToSvg/svgToGrid
  // doesn't silently invalidate the assertion.
  it('coordinate stubs round-trip grid → SVG → grid', () => {
    const seCornerSvg = gridToSvg(115, 31, dims);
    const back = svgToGrid(seCornerSvg.x, seCornerSvg.y, dims);
    expect(back.x).toBeCloseTo(115);
    expect(back.y).toBeCloseTo(31);
  });

  it('marks zone handles as swipe-blocked so drawer gestures ignore zone drags', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const seHandle = screen.getByTestId('zone-handle-se');
    const moveHandle = screen.getByTestId('zone-handle-move');

    expect(screen.getByTestId('zone-board-container').closest('[data-swipe-blocked]')).toBe(
      screen.getByTestId('zone-board-container'),
    );
    expect(seHandle.closest('[data-swipe-blocked]')).toBe(seHandle);
    expect(moveHandle.closest('[data-swipe-blocked]')).toBe(moveHandle);
  });

  it('renders larger invisible hit targets around zone handles', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const seHandleRadius = Number(screen.getByTestId('zone-handle-se').getAttribute('r'));
    const seHitRadius = Number(screen.getByTestId('zone-hit-se').getAttribute('r'));
    const moveHandleRadius = Number(screen.getByTestId('zone-handle-move').getAttribute('r'));
    const moveHitRadius = Number(screen.getByTestId('zone-hit-move').getAttribute('r'));
    const moveBorderHitTarget = screen.getByTestId('zone-hit-move-border');

    expect(seHitRadius).toBeGreaterThan(seHandleRadius * 2);
    expect(moveHitRadius).toBeGreaterThan(moveHandleRadius * 2);
    expect(Number(moveBorderHitTarget.getAttribute('stroke-width'))).toBe(seHitRadius);
    expect(moveBorderHitTarget.getAttribute('pointer-events')).toBe('stroke');
    expect(screen.getByTestId('zone-hit-se').closest('[data-swipe-blocked]')).toBe(screen.getByTestId('zone-hit-se'));
    expect(screen.getByTestId('zone-hit-move').closest('[data-swipe-blocked]')).toBe(
      screen.getByTestId('zone-hit-move'),
    );
    expect(moveBorderHitTarget.closest('[data-swipe-blocked]')).toBe(moveBorderHitTarget);
  });

  it('dragging the SE corner shrinks the zone and prunes holds outside the new box', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const seHandle = screen.getByTestId('zone-handle-se');

    // SE corner starts at grid (115, 31) → SVG (862.5, 937.5).
    fireEvent.pointerDown(seHandle, { clientX: 862.5, clientY: 937.5, pointerId: 1 });
    // Drag inward to grid (70, 76) → SVG (525, 600).
    fireEvent.pointerMove(seHandle, { clientX: 525, clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(seHandle, { clientX: 525, clientY: 600, pointerId: 1 });

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(dragCall).toBeDefined();
    // SE corner moved -45 in x, +45 in y. clampZoneBox keeps min size and
    // rounds to integer grid coords.
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 70, edgeBottom: 76, edgeTop: 125 });
    // Hold 101 at grid (60, 80) is inside the new box; the other two are
    // dropped. Critical check: a regression that removed pruneHoldsToZone
    // from endDrag (while keeping it in handleEnable) would fail here.
    expect(dragCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });

  it('persists the latest valid drag box when iOS cancels with bogus coordinates', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const seHandle = screen.getByTestId('zone-handle-se');

    fireEvent.pointerDown(seHandle, { clientX: 862.5, clientY: 937.5, pointerId: 1 });
    fireEvent.pointerMove(seHandle, { clientX: 525, clientY: 600, pointerId: 1 });
    fireEvent.pointerCancel(seHandle, { clientX: 0, clientY: 1170, pointerId: 1 });

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(dragCall).toBeDefined();
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 70, edgeBottom: 76, edgeTop: 125 });
    expect(dragCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });

  it('dragging the move handle translates the zone and prunes holds outside the new box', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const moveHandle = screen.getByTestId('zone-handle-move');

    // Centre starts at grid (72, 78) → SVG (540, 585). Drag to grid (82, 88) → SVG (615, 510).
    fireEvent.pointerDown(moveHandle, { clientX: 540, clientY: 585, pointerId: 1 });
    fireEvent.pointerMove(moveHandle, { clientX: 615, clientY: 510, pointerId: 1 });
    fireEvent.pointerUp(moveHandle, { clientX: 615, clientY: 510, pointerId: 1 });

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as
      | { zoneBox: ZoneBox; holdsFilter: HoldsFilter }
      | undefined;
    expect(dragCall).toBeDefined();
    // Move-mode translates both edges on each axis by the same delta — width
    // (86) and height (94) are preserved, unlike the SE-corner case.
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 39, edgeRight: 125, edgeBottom: 41, edgeTop: 135 });
    // Hold 101 at grid (60, 80) is still inside; the two outer holds are pruned.
    expect(dragCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });
});
