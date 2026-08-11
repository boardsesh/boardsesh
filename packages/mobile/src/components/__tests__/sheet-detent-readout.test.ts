// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// The store's own module graph reaches MMKV (settings) and expo-updates
// (eligibility); neither loads under vitest's node env.
const settings = vi.hoisted(() => ({ sheetDetentDiagnostics: false }));
vi.mock('../../settings', () => ({
  useSetting: (key: 'sheetDetentDiagnostics') => [settings[key], vi.fn()],
}));
const eligibility = vi.hoisted(() => ({ eligible: false }));
vi.mock('../../hooks/use-diagnostics-eligible', () => ({
  useDiagnosticsEligible: () => eligibility.eligible,
}));

import {
  clearSheetDetentReadings,
  publishSheetDetentReading,
  useSheetDetentReadings,
  useSheetDetentReadoutEnabled,
  type SheetDetentReading,
} from '../sheet-detent-readout';

function reading(overrides: Partial<Omit<SheetDetentReading, 'sequence'>> = {}): Omit<SheetDetentReading, 'sequence'> {
  return {
    sheet: 'Sheet',
    window: { width: 375, height: 667 },
    insets: { top: 20, bottom: 0 },
    formulaHeight: 541,
    probeHeight: 548,
    columnHeight: 541,
    sentinelY: 16,
    availableInFlowHeight: 532,
    ...overrides,
  };
}

function publish(overrides: Partial<Omit<SheetDetentReading, 'sequence'>> = {}): void {
  act(() => publishSheetDetentReading(reading(overrides)));
}

// The store is module-level state shared by every sheet, so each case starts clean.
beforeEach(() => {
  clearSheetDetentReadings();
  settings.sheetDetentDiagnostics = false;
  eligibility.eligible = false;
});

describe('sheet detent readings store', () => {
  it('keeps one entry per sheet, most recent first', () => {
    const { result } = renderHook(() => useSheetDetentReadings());
    publish({ sheet: 'Sheet' });
    publish({ sheet: 'ClimbFilterSheet' });

    expect(result.current.map((entry) => entry.sheet)).toEqual(['ClimbFilterSheet', 'Sheet']);
  });

  it('replaces a sheet reading in place rather than stacking every relayout', () => {
    // Layout fires repeatedly during a present animation; the panel should show
    // the current numbers, not a scrolling history that pushes the others out.
    const { result } = renderHook(() => useSheetDetentReadings());
    publish({ sheet: 'Sheet', columnHeight: 541 });
    publish({ sheet: 'ModalSheet' });
    publish({ sheet: 'Sheet', columnHeight: 390 });

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toMatchObject({ sheet: 'Sheet', columnHeight: 390 });
  });

  it('bumps the sequence so a tester can see readings still arriving', () => {
    const { result } = renderHook(() => useSheetDetentReadings());
    publish();
    const first = result.current[0].sequence;
    publish();
    expect(result.current[0].sequence).toBe(first + 1);
  });

  it('caps the panel at four sheets, dropping the oldest', () => {
    const { result } = renderHook(() => useSheetDetentReadings());
    for (const sheet of ['a', 'b', 'c', 'd', 'e']) publish({ sheet });
    expect(result.current.map((entry) => entry.sheet)).toEqual(['e', 'd', 'c', 'b']);
  });

  it('hands back a reference-stable snapshot across renders', () => {
    // useSyncExternalStore loops render → forceStoreRerender if getSnapshot
    // returns a fresh array on every call.
    const { result, rerender } = renderHook(() => useSheetDetentReadings());
    publish();
    const snapshot = result.current;
    rerender();
    expect(result.current).toBe(snapshot);
  });

  it('empties the panel on clear', () => {
    const { result } = renderHook(() => useSheetDetentReadings());
    publish();
    expect(result.current).toHaveLength(1);
    act(() => clearSheetDetentReadings());
    expect(result.current).toEqual([]);
  });
});

describe('useSheetDetentReadoutEnabled', () => {
  it('needs both the toggle and a diagnostics-eligible session', () => {
    const { result, rerender } = renderHook(() => useSheetDetentReadoutEnabled());
    expect(result.current).toBe(false);

    settings.sheetDetentDiagnostics = true;
    rerender();
    // A production install can flip nothing, because the row never renders — but
    // a stale persisted `true` from an earlier preview must not turn it on either.
    expect(result.current).toBe(false);

    eligibility.eligible = true;
    rerender();
    expect(result.current).toBe(true);

    settings.sheetDetentDiagnostics = false;
    rerender();
    expect(result.current).toBe(false);
  });
});
