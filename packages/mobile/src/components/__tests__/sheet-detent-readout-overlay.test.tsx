// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

// Settings reaches MMKV and eligibility reaches expo-updates; neither loads
// under vitest's node env.
const settings = vi.hoisted(() => ({ sheetDetentDiagnostics: false }));
vi.mock('../../settings', () => ({
  useSetting: (key: 'sheetDetentDiagnostics') => [settings[key], vi.fn()],
}));
const eligibility = vi.hoisted(() => ({ eligible: false }));
vi.mock('../../hooks/use-diagnostics-eligible', () => ({
  useDiagnosticsEligible: () => eligibility.eligible,
}));

const store = vi.hoisted(() => ({
  readings: [] as unknown[],
  clear: vi.fn(),
  setActive: vi.fn(),
}));
vi.mock('../sheet-detent-readout', () => ({
  useSheetDetentReadings: () => store.readings,
  clearSheetDetentReadings: store.clear,
  setSheetDetentReadoutActive: store.setActive,
}));

import { SheetDetentReadoutOverlay } from '../SheetDetentReadoutOverlay';

beforeEach(() => {
  settings.sheetDetentDiagnostics = false;
  eligibility.eligible = false;
  store.readings = [];
  store.clear.mockClear();
  store.setActive.mockClear();
});

describe('SheetDetentReadoutOverlay', () => {
  it('renders nothing and instruments nothing on an ordinary install', () => {
    // The whole point of shipping this OTA: a production session must see no
    // extra surface, and its sheets must mount no probe views.
    settings.sheetDetentDiagnostics = true;
    store.readings = [sampleReading()];
    const { container } = render(<SheetDetentReadoutOverlay />);

    expect(container.textContent).toBe('');
    // A stale persisted `true` from an earlier preview must not switch it on.
    expect(store.setActive).toHaveBeenCalledWith(false);
  });

  it('stays off for an eligible session until the tester flips the toggle', () => {
    eligibility.eligible = true;
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toBe('');
    expect(store.setActive).toHaveBeenCalledWith(false);
  });

  it('turns the sheets on once both gates pass', () => {
    eligibility.eligible = true;
    settings.sheetDetentDiagnostics = true;
    render(<SheetDetentReadoutOverlay />);
    expect(store.setActive).toHaveBeenCalledWith(true);
  });

  it('shows the numbers #3922 is waiting on, padding-corrected', () => {
    enable();
    store.readings = [sampleReading()];
    const { container } = render(<SheetDetentReadoutOverlay />);

    expect(container.textContent).toContain('ClimbFilterSheet');
    expect(container.textContent).toContain('formula 541');
    expect(container.textContent).toContain('column 390');
    expect(container.textContent).toContain('probe 548');
    expect(container.textContent).toContain('padTop 16');
    // The verdict number: ~548 means the native size report is right and the gap
    // lives elsewhere; ~391 means the report itself is short of the detent.
    expect(container.textContent).toContain('inFlow 532');
  });

  it('renders a missing measurement as an em dash rather than a zero', () => {
    // A partial reading is the normal state right after the toggle is flipped.
    enable();
    store.readings = [sampleReading({ columnHeight: null, availableInFlowHeight: null })];
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toContain('column —');
    expect(container.textContent).toContain('inFlow —');
    expect(container.textContent).not.toContain('inFlow 0');
  });

  it('tells the tester what to do before any sheet has been opened', () => {
    enable();
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toContain('Open a sheet');
  });
});

function enable(): void {
  eligibility.eligible = true;
  settings.sheetDetentDiagnostics = true;
}

function sampleReading(overrides: Record<string, unknown> = {}) {
  return {
    sheet: 'ClimbFilterSheet',
    window: { width: 375, height: 667 },
    insets: { top: 20, bottom: 0 },
    formulaHeight: 541,
    probeHeight: 548,
    columnHeight: 390,
    sentinelY: 16,
    availableInFlowHeight: 532,
    sequence: 3,
    ...overrides,
  };
}
