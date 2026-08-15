import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import React, { useRef, useEffect } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import HoldTypePicker, { buildOptions } from '../hold-type-picker';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// Mock HOLD_STATE_MAP so picker color assertions don't depend on the real LED
// colors — if production LED hex values change, these tests should keep passing
// because the picker logic is what's under test, not the colors themselves.
vi.mock('../../board-renderer/types', () => ({
  HOLD_STATE_MAP: {
    kilter: {
      42: { name: 'STARTING', color: '#11AA11' },
      43: { name: 'HAND', color: '#11AAAA' },
      44: { name: 'FINISH', color: '#AA11AA' },
      45: { name: 'FOOT', color: '#AA8800' },
    },
    tension: {
      1: { name: 'STARTING', displayColor: '#22BB22', color: '#11AA11' },
      2: { name: 'HAND', displayColor: '#2222BB', color: '#1111AA' },
      3: { name: 'FINISH', color: '#AA1111' },
      4: { name: 'FOOT', color: '#AA11AA' },
    },
    moonboard: {
      42: { name: 'STARTING', color: '#11AA11', displayColor: '#33CC33' },
      43: { name: 'HAND', color: '#1111AA', displayColor: '#3333CC' },
      44: { name: 'FINISH', color: '#AA1111', displayColor: '#CC2222' },
      // BLE-preview-only entries that should NOT show up in the picker.
      45: { name: 'FOOT', color: '#11AAAA' },
      46: { name: 'AUX', color: '#FFE066' },
    },
    decoy: {
      1: { name: 'STARTING', color: '#11AA11' },
      2: { name: 'HAND', color: '#1111AA' },
      3: { name: 'FINISH', color: '#AA1111' },
      4: { name: 'FOOT', color: '#AA11AA' },
    },
    touchstone: {
      1: { name: 'STARTING', color: '#11AA11' },
      2: { name: 'HAND', color: '#1111AA' },
      3: { name: 'FINISH', color: '#AA1111' },
      4: { name: 'FOOT', color: '#AA11AA' },
    },
    grasshopper: {
      1: { name: 'STARTING', color: '#11AA11' },
      2: { name: 'HAND', color: '#1111AA' },
      3: { name: 'FINISH', color: '#AA1111' },
      4: { name: 'FOOT', color: '#AA11AA' },
    },
  },
}));

// Note: MUI Popover prints "anchorEl is invalid" warnings during the brief
// window between `cleanup()` and the Popover exit transition. They're benign
// noise specific to the test harness — the component itself is verified
// correct by the assertions below.

afterEach(() => {
  cleanup();
});

/**
 * Render the picker with the anchor element as a sibling inside the RTL
 * container so it gets unmounted by `cleanup()` rather than left dangling
 * in document.body across tests.
 */
function PickerHarness(
  // The tests in this file all exercise the setter-mode picker, so type the
  // harness against SetterPickerProps directly. Search-mode coverage lives
  // alongside the search form's tests.
  props: Omit<import('../hold-type-picker').SetterPickerProps, 'anchorEl'> & {
    withAnchor: boolean;
  },
) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = React.useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (props.withAnchor) {
      setAnchor(anchorRef.current);
    }
  }, [props.withAnchor]);

  return (
    <>
      <div ref={anchorRef} data-testid="anchor" />
      <HoldTypePicker {...props} anchorEl={anchor} />
    </>
  );
}

function renderPicker(
  overrides: Partial<import('../hold-type-picker').SetterPickerProps> & {
    withAnchor?: boolean;
  } = {},
) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const { withAnchor = true, ...pickerProps } = overrides;

  const utils = render(
    <PickerHarness
      boardName="kilter"
      currentState="OFF"
      startingCount={0}
      finishCount={0}
      onSelect={onSelect}
      onClose={onClose}
      withAnchor={withAnchor}
      {...pickerProps}
    />,
  );

  return { ...utils, onSelect, onClose };
}

describe('buildOptions', () => {
  it('returns Start, Mid, Finish, Foot for Kilter', () => {
    const options = buildOptions('kilter');
    expect(options.map((o) => o.state)).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT']);
  });

  it('returns Start, Mid, Finish, Foot for Tension', () => {
    const options = buildOptions('tension');
    expect(options.map((o) => o.state)).toEqual(['STARTING', 'HAND', 'FINISH', 'FOOT']);
  });

  it('skips Foot for MoonBoard', () => {
    const options = buildOptions('moonboard');
    expect(options.map((o) => o.state)).toEqual(['STARTING', 'HAND', 'FINISH']);
    expect(options.map((o) => o.state)).not.toContain('FOOT');
  });

  it('uses board-specific colors', () => {
    const kilter = buildOptions('kilter');
    const tension = buildOptions('tension');
    const moonboard = buildOptions('moonboard');

    // Kilter has no displayColor, so the picker uses the raw color.
    expect(kilter.find((o) => o.state === 'STARTING')?.color).toBe('#11AA11');
    expect(kilter.find((o) => o.state === 'FOOT')?.color).toBe('#AA8800');
    // Tension prefers displayColor over color when present.
    expect(tension.find((o) => o.state === 'STARTING')?.color).toBe('#22BB22');
    // MoonBoard also has a displayColor that should win over color.
    expect(moonboard.find((o) => o.state === 'STARTING')?.color).toBe('#33CC33');
  });
});

describe('HoldTypePicker', () => {
  it('renders all four hold types and Clear for Aurora boards', () => {
    renderPicker({ boardName: 'kilter' });

    expect(screen.getByLabelText('Start')).toBeTruthy();
    expect(screen.getByLabelText('Mid')).toBeTruthy();
    expect(screen.getByLabelText('Finish')).toBeTruthy();
    expect(screen.getByLabelText('Foot')).toBeTruthy();
    expect(screen.getByLabelText('Clear')).toBeTruthy();
  });

  it('omits Foot for MoonBoard', () => {
    renderPicker({ boardName: 'moonboard' });

    expect(screen.getByLabelText('Start')).toBeTruthy();
    expect(screen.getByLabelText('Mid')).toBeTruthy();
    expect(screen.getByLabelText('Finish')).toBeTruthy();
    expect(screen.queryByLabelText('Foot')).toBeNull();
    expect(screen.getByLabelText('Clear')).toBeTruthy();
  });

  it('does not render when anchorEl is null', () => {
    renderPicker({ withAnchor: false });

    // Popover is closed → no swatches should be in the DOM.
    expect(screen.queryByLabelText('Start')).toBeNull();
  });

  it('calls onSelect when a swatch is clicked', () => {
    const { onSelect } = renderPicker({ boardName: 'kilter' });

    fireEvent.click(screen.getByLabelText('Start'));
    expect(onSelect).toHaveBeenCalledWith('STARTING');

    fireEvent.click(screen.getByLabelText('Foot'));
    expect(onSelect).toHaveBeenCalledWith('FOOT');
  });

  it('calls onSelect with OFF when Clear is clicked', () => {
    const { onSelect } = renderPicker({
      boardName: 'kilter',
      currentState: 'STARTING',
    });

    fireEvent.click(screen.getByLabelText('Clear'));
    expect(onSelect).toHaveBeenCalledWith('OFF');
  });

  it('disables STARTING when startingCount is at the max of 2', () => {
    const { onSelect } = renderPicker({
      boardName: 'kilter',
      startingCount: 2,
      currentState: 'OFF',
    });

    const startButton = screen.getByLabelText('Start');
    expect((startButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(startButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disables FINISH when finishCount is at the max of 2', () => {
    const { onSelect } = renderPicker({
      boardName: 'kilter',
      finishCount: 2,
      currentState: 'OFF',
    });

    const finishButton = screen.getByLabelText('Finish');
    expect((finishButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(finishButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps STARTING enabled when this hold is already STARTING and at the cap', () => {
    // The user is editing a hold that already counts toward the cap; allowing
    // re-selection lets them confirm the same state without surprising no-ops.
    const { onSelect } = renderPicker({
      boardName: 'kilter',
      startingCount: 2,
      currentState: 'STARTING',
    });

    const startButton = screen.getByLabelText('Start');
    expect((startButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(startButton);
    expect(onSelect).toHaveBeenCalledWith('STARTING');
  });

  it('marks the active swatch with aria-pressed', () => {
    renderPicker({ boardName: 'kilter', currentState: 'FINISH' });

    expect(screen.getByLabelText('Finish').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('Start').getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps FOOT enabled even when starting/finish are capped', () => {
    const { onSelect } = renderPicker({
      boardName: 'kilter',
      startingCount: 2,
      finishCount: 2,
    });

    const footButton = screen.getByLabelText('Foot');
    expect((footButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(footButton);
    expect(onSelect).toHaveBeenCalledWith('FOOT');
  });
});
