import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react';
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

// Capture the BoardRenderer onHoldClick prop so tests can simulate a hold tap
// without rendering the real BoardRenderer (which would drag in the whole
// board image pipeline). The form wraps its picker callback with an in-zone
// guard, so this is the only way to exercise that wrapper in tests.
type CapturedOnHoldClick = (holdId: number, anchor: Element) => void;
let capturedBoardRendererOnHoldClick: CapturedOnHoldClick | null = null;
vi.mock('../../board-renderer/board-renderer', () => ({
  default: ({ onHoldClick }: { onHoldClick?: CapturedOnHoldClick }) => {
    capturedBoardRendererOnHoldClick = onHoldClick ?? null;
    return null;
  },
}));

vi.mock('../../create-climb/hold-type-picker', () => ({
  default: () => null,
}));

// Capture the heatmap overlay's onLoadingChange callback so a test can flip
// the form into "heatmap is loading" without actually fetching.
let capturedHeatmapOnLoadingChange: ((loading: boolean) => void) | null = null;
vi.mock('../../create-climb/create-climb-heatmap-overlay', () => ({
  default: ({ onLoadingChange }: { onLoadingChange?: (loading: boolean) => void }) => {
    capturedHeatmapOnLoadingChange = onLoadingChange ?? null;
    return null;
  },
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
// Captured so tests can verify whether the form's in-zone guard let a tap
// reach the picker.
const pickerHandleHoldClickMock = vi.fn();

vi.mock('../use-search-hold-picker', () => ({
  useSearchHoldPicker: (options: { setHoldFilter: CapturedSetHoldFilter }) => {
    capturedSetHoldFilter = options.setHoldFilter;
    return {
      anchorEl: null,
      activeHoldId: null,
      currentEntry: {},
      handleHoldClick: pickerHandleHoldClickMock,
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

type ZoneUpdateCall = {
  zoneBox: ZoneBox;
  zoneMode?: 'allHolds' | 'anyHold';
  holdsFilter?: HoldsFilter;
};

// Reset every module-level mock between tests. Older suites only zeroed
// the call mocks they directly asserted on, which set a trap for any new
// test reading a stale captured callback or call count.
const resetSharedMocks = () => {
  mockUpdateFilters.mockClear();
  pickerHandleHoldClickMock.mockClear();
  capturedBoardRendererOnHoldClick = null;
  capturedHeatmapOnLoadingChange = null;
  capturedSetHoldFilter = null;
  mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS };
};

describe('ClimbSearchForm — zone changes prune out-of-zone holds', () => {
  beforeEach(resetSharedMocks);

  it('clicking Draw zone keeps only the holds inside the default zone', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, holdsFilter: filterAllThreeHolds };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const drawButton = screen.getByRole('button', { name: 'Draw zone' });
    fireEvent.click(drawButton);

    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
    expect(lastCall?.zoneMode).toBe('allHolds');
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
    expect(lastCall).toEqual({ zoneBox: null, zoneMode: 'allHolds' });
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

    const lastCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
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
    expect(screen.getByRole('button', { name: 'All holds inside' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'At least 1 hold' })).toBeTruthy();
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
      expect(node.getAttribute('fill')).toBe('#16111F');
      expect(node.getAttribute('fill-opacity')).toBe('0.42');
      // Exclusion rects must absorb pointer events so taps on dimmed holds
      // outside the zone never reach BoardRenderer underneath (issue #2040).
      expect(node.getAttribute('pointer-events')).toBe('all');
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
    // Velvet: the zone outline stroke is the scheme-aware foreground violet, applied
    // via a style prop (so the CSS var resolves) rather than the SVG stroke attribute.
    expect(outline.style.stroke).toBe('var(--color-primary)');
    expect(outline.getAttribute('pointer-events')).toBe('none');
  });

  it('renders any-hold zones without dimming or blocking the rest of the board', () => {
    const persistedZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: persistedZone,
      zoneMode: 'anyHold',
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    expect(screen.queryByTestId('zone-exclusion-top')).toBeNull();
    expect(screen.queryByTestId('zone-exclusion-bottom')).toBeNull();
    expect(screen.queryByTestId('zone-exclusion-left')).toBeNull();
    expect(screen.queryByTestId('zone-exclusion-right')).toBeNull();
    expect(screen.getByTestId('zone-selection-outline')).toBeTruthy();
  });

  it('switching to any-hold mode keeps existing hold filters outside the zone', () => {
    const persistedZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: persistedZone,
      zoneMode: 'allHolds',
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: 'At least 1 hold' }));

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({ zoneMode: 'anyHold' });
  });

  it('switching back to all-holds mode prunes hold filters outside the zone', () => {
    const persistedZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: persistedZone,
      zoneMode: 'anyHold',
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: 'All holds inside' }));

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({
      zoneMode: 'allHolds',
      holdsFilter: { 101: { STARTING: 'include' } },
    });
  });

  it('drawing a zone twice (e.g. user clears and redraws) prunes again from current holdsFilter', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, holdsFilter: filterAllThreeHolds };
    const { rerender } = render(<ClimbSearchForm boardDetails={boardDetails} />);

    fireEvent.click(screen.getByRole('button', { name: 'Draw zone' }));
    const firstDraw = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
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
    const secondDraw = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(secondDraw?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
    expect(secondDraw?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
    expect(secondDraw?.zoneMode).toBe('allHolds');
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
    const drawCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(drawCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
    expect(drawCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 });
    expect(drawCall?.zoneMode).toBe('allHolds');
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

  beforeEach(resetSharedMocks);

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
    // The visible move handle is now a crosshair + small dot, not a single
    // big circle. Compare the hit radius against the centre-dot radius so
    // the "much bigger than the visible mark" guarantee survives the
    // visual swap that landed for issue #2040.
    const moveDotRadius = Number(screen.getByTestId('zone-handle-move-dot').getAttribute('r'));
    const moveHitRadius = Number(screen.getByTestId('zone-hit-move').getAttribute('r'));
    const moveBorderHitTarget = screen.getByTestId('zone-hit-move-border');

    expect(seHitRadius).toBeGreaterThan(seHandleRadius * 2);
    expect(moveHitRadius).toBeGreaterThan(moveDotRadius * 2);
    expect(Number(moveBorderHitTarget.getAttribute('stroke-width'))).toBe(seHitRadius);
    expect(moveBorderHitTarget.getAttribute('pointer-events')).toBe('stroke');
    expect(screen.getByTestId('zone-hit-se').closest('[data-swipe-blocked]')).toBe(screen.getByTestId('zone-hit-se'));
    expect(screen.getByTestId('zone-hit-move').closest('[data-swipe-blocked]')).toBe(
      screen.getByTestId('zone-hit-move'),
    );
    expect(moveBorderHitTarget.closest('[data-swipe-blocked]')).toBe(moveBorderHitTarget);
  });

  it('draws the centre move handle as a crosshair so holds underneath stay visible', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    // The visible move handle is a <g> containing two crosshair lines and a
    // small centre dot. The dot must be meaningfully smaller than a hold
    // (r=30 in this test board) so it doesn't cover holds underneath.
    expect(screen.getByTestId('zone-handle-move').tagName.toLowerCase()).toBe('g');
    expect(screen.getByTestId('zone-handle-move-crosshair-h')).toBeTruthy();
    expect(screen.getByTestId('zone-handle-move-crosshair-v')).toBeTruthy();
    const dotRadius = Number(screen.getByTestId('zone-handle-move-dot').getAttribute('r'));
    expect(dotRadius).toBeLessThan(30);
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

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(dragCall).toBeDefined();
    // SE corner moved -45 in x, +45 in y. clampZoneBox keeps min size and
    // rounds to integer grid coords.
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 70, edgeBottom: 76, edgeTop: 125 });
    expect(dragCall?.zoneMode).toBe('allHolds');
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

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(dragCall).toBeDefined();
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 29, edgeRight: 70, edgeBottom: 76, edgeTop: 125 });
    expect(dragCall?.zoneMode).toBe('allHolds');
    expect(dragCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });

  it('dragging in any-hold mode preserves hold filters outside the new box', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: startZone,
      zoneMode: 'anyHold',
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    const seHandle = screen.getByTestId('zone-handle-se');
    fireEvent.pointerDown(seHandle, { clientX: 862.5, clientY: 937.5, pointerId: 1 });
    fireEvent.pointerMove(seHandle, { clientX: 525, clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(seHandle, { clientX: 525, clientY: 600, pointerId: 1 });

    expect(mockUpdateFilters.mock.calls.at(-1)?.[0]).toEqual({
      zoneBox: { edgeLeft: 29, edgeRight: 70, edgeBottom: 76, edgeTop: 125 },
      zoneMode: 'anyHold',
    });
  });

  it('dragging the move handle translates the zone and prunes holds outside the new box', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = {
      ...DEFAULT_SEARCH_PARAMS,
      holdsFilter: filterAllThreeHolds,
      zoneBox: startZone,
    };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    // The visible crosshair group is decorative (pointer-events: none); the
    // hit-circle below is the actual drag target, matching the browser path.
    const moveTarget = screen.getByTestId('zone-hit-move');

    // Centre starts at grid (72, 78) → SVG (540, 585). Drag to grid (82, 88) → SVG (615, 510).
    fireEvent.pointerDown(moveTarget, { clientX: 540, clientY: 585, pointerId: 1 });
    fireEvent.pointerMove(moveTarget, { clientX: 615, clientY: 510, pointerId: 1 });
    fireEvent.pointerUp(moveTarget, { clientX: 615, clientY: 510, pointerId: 1 });

    const dragCall = mockUpdateFilters.mock.calls.at(-1)?.[0] as ZoneUpdateCall | undefined;
    expect(dragCall).toBeDefined();
    // Move-mode translates both edges on each axis by the same delta — width
    // (86) and height (94) are preserved, unlike the SE-corner case.
    expect(dragCall?.zoneBox).toEqual({ edgeLeft: 39, edgeRight: 125, edgeBottom: 41, edgeTop: 135 });
    expect(dragCall?.zoneMode).toBe('allHolds');
    // Hold 101 at grid (60, 80) is still inside; the two outer holds are pruned.
    expect(dragCall?.holdsFilter).toEqual({ 101: { STARTING: 'include' } });
  });
});

describe('ClimbSearchForm — in-zone hold tap guard', () => {
  beforeEach(resetSharedMocks);

  it('drops taps on holds outside the active zone before the picker opens', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, zoneBox: startZone };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    expect(capturedBoardRendererOnHoldClick).not.toBeNull();
    const fakeAnchor = document.createElement('div');
    // Hold 103 is at grid (140, 150) — outside the active zone.
    capturedBoardRendererOnHoldClick!(outsideTopRightHold.id, fakeAnchor);

    expect(pickerHandleHoldClickMock).not.toHaveBeenCalled();
  });

  it('passes taps on holds inside the active zone through to the picker', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, zoneBox: startZone };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    expect(capturedBoardRendererOnHoldClick).not.toBeNull();
    const fakeAnchor = document.createElement('div');
    // Hold 101 at grid (60, 80) is inside the zone.
    capturedBoardRendererOnHoldClick!(insideHold.id, fakeAnchor);

    expect(pickerHandleHoldClickMock).toHaveBeenCalledTimes(1);
    expect(pickerHandleHoldClickMock).toHaveBeenCalledWith(insideHold.id, fakeAnchor);
  });

  it('passes every tap through when no zone is set', () => {
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, zoneBox: null };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    expect(capturedBoardRendererOnHoldClick).not.toBeNull();
    const fakeAnchor = document.createElement('div');
    capturedBoardRendererOnHoldClick!(outsideTopRightHold.id, fakeAnchor);

    expect(pickerHandleHoldClickMock).toHaveBeenCalledTimes(1);
  });

  it('passes outside-zone taps through in any-hold mode', () => {
    const startZone: ZoneBox = { edgeLeft: 29, edgeRight: 115, edgeBottom: 31, edgeTop: 125 };
    mockUISearchParams = { ...DEFAULT_SEARCH_PARAMS, zoneBox: startZone, zoneMode: 'anyHold' };
    render(<ClimbSearchForm boardDetails={boardDetails} />);

    expect(capturedBoardRendererOnHoldClick).not.toBeNull();
    const fakeAnchor = document.createElement('div');
    capturedBoardRendererOnHoldClick!(outsideTopRightHold.id, fakeAnchor);

    expect(pickerHandleHoldClickMock).toHaveBeenCalledTimes(1);
    expect(pickerHandleHoldClickMock).toHaveBeenCalledWith(outsideTopRightHold.id, fakeAnchor);
  });
});

describe('ClimbSearchForm — heatmap toggle', () => {
  beforeEach(resetSharedMocks);

  it('renders the fire icon (not the layers icon) when the heatmap is off', () => {
    render(<ClimbSearchForm boardDetails={boardDetails} />);
    const button = screen.getByRole('button', { name: 'Show heatmap' });
    // MUI's icons render as <svg data-testid="LocalFireDepartmentOutlinedIcon">
    // in tests. Querying via the inner svg's data-testid is the most stable
    // way to assert which icon is mounted.
    expect(button.querySelector('[data-testid="LocalFireDepartmentOutlinedIcon"]')).toBeTruthy();
    expect(button.querySelector('[data-testid="LayersOutlinedIcon"]')).toBeNull();
  });

  it('shows the filled fire icon when the heatmap is enabled', () => {
    render(<ClimbSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show heatmap' }));
    const button = screen.getByRole('button', { name: 'Hide heatmap' });
    expect(button.querySelector('[data-testid="LocalFireDepartmentIcon"]')).toBeTruthy();
  });

  it('swaps the icon for a spinner while the heatmap data is loading', () => {
    render(<ClimbSearchForm boardDetails={boardDetails} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show heatmap' }));

    expect(capturedHeatmapOnLoadingChange).not.toBeNull();
    // The overlay reports loading=true while its fetch is in flight.
    act(() => capturedHeatmapOnLoadingChange!(true));

    const button = screen.getByRole('button', { name: 'Hide heatmap' });
    expect(screen.getByTestId('heatmap-loading-spinner')).toBeTruthy();
    expect(button.querySelector('[data-testid="LocalFireDepartmentIcon"]')).toBeNull();

    act(() => capturedHeatmapOnLoadingChange!(false));
    // Once loading clears, the fire icon comes back.
    expect(screen.queryByTestId('heatmap-loading-spinner')).toBeNull();
    expect(button.querySelector('[data-testid="LocalFireDepartmentIcon"]')).toBeTruthy();
  });
});
