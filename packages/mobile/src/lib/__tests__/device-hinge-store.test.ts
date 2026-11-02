// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { publishHingeStatus, resetHingeStatusForTests, useHingePartiallyOpen } from '../device-hinge-store';

describe('device-hinge-store', () => {
  afterEach(() => {
    resetHingeStatusForTests();
  });

  it('starts flat, so a phone with no hinge lays out as before', () => {
    const { result } = renderHook(() => useHingePartiallyOpen());
    expect(result.current).toBe(false);
  });

  it('turns on for a half-open hinge and off again when it opens fully or closes', () => {
    const { result } = renderHook(() => useHingePartiallyOpen());
    act(() => publishHingeStatus('partiallyOpen'));
    expect(result.current).toBe(true);
    act(() => publishHingeStatus('fullyOpen'));
    expect(result.current).toBe(false);
    act(() => publishHingeStatus('partiallyOpen'));
    act(() => publishHingeStatus('closed'));
    expect(result.current).toBe(false);
  });

  it('treats a missing or unrecognised hinge as flat', () => {
    const { result } = renderHook(() => useHingePartiallyOpen());
    act(() => publishHingeStatus('partiallyOpen'));
    act(() => publishHingeStatus(null));
    expect(result.current).toBe(false);
    act(() => publishHingeStatus('partiallyOpen'));
    act(() => publishHingeStatus('unknown'));
    expect(result.current).toBe(false);
  });

  it('re-renders once per status change, not once per hinge report', () => {
    let renderCount = 0;
    renderHook(() => {
      renderCount += 1;
      return useHingePartiallyOpen();
    });
    const rendersBefore = renderCount;
    act(() => {
      // The angle stream while someone folds: many reports, one status edge.
      for (let report = 0; report < 30; report += 1) publishHingeStatus('partiallyOpen');
    });
    expect(renderCount).toBe(rendersBefore + 1);
  });
});
