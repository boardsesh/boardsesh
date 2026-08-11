// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const overlay = vi.hoisted(() => ({ enabled: false }));

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

// The store module reaches MMKV + expo-updates; drive it directly instead.
const store = vi.hoisted(() => ({
  readings: [] as unknown[],
  clear: vi.fn(),
}));
vi.mock('../sheet-detent-readout', () => ({
  useSheetDetentReadoutEnabled: () => overlay.enabled,
  useSheetDetentReadings: () => store.readings,
  clearSheetDetentReadings: store.clear,
}));

import { SheetDetentReadoutOverlay } from '../SheetDetentReadoutOverlay';

beforeEach(() => {
  overlay.enabled = false;
  store.readings = [];
  store.clear.mockClear();
});

describe('SheetDetentReadoutOverlay', () => {
  it('renders nothing when the tester toggle is off', () => {
    // The whole point of shipping this OTA: an ordinary install must see no
    // extra surface at all.
    store.readings = [sampleReading()];
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toBe('');
  });

  it('shows the numbers #3922 is waiting on, padding-corrected', () => {
    overlay.enabled = true;
    store.readings = [sampleReading()];
    const { container } = render(<SheetDetentReadoutOverlay />);

    expect(container.textContent).toContain('ClimbFilterSheet');
    expect(container.textContent).toContain('formula 541');
    expect(container.textContent).toContain('column 390');
    expect(container.textContent).toContain('probe 548');
    expect(container.textContent).toContain('padTop 16');
    // The verdict number: 548 would mean the native size report is right and the
    // gap lives elsewhere; ~391 would mean the report itself is short.
    expect(container.textContent).toContain('inFlow 532');
  });

  it('renders a missing measurement as an em dash rather than a zero', () => {
    // A partial reading is the normal state right after the toggle is flipped.
    overlay.enabled = true;
    store.readings = [sampleReading({ columnHeight: null, availableInFlowHeight: null })];
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toContain('column —');
    expect(container.textContent).toContain('inFlow —');
    expect(container.textContent).not.toContain('inFlow 0');
  });

  it('tells the tester what to do before any sheet has been opened', () => {
    overlay.enabled = true;
    const { container } = render(<SheetDetentReadoutOverlay />);
    expect(container.textContent).toContain('Open a sheet');
  });
});

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
