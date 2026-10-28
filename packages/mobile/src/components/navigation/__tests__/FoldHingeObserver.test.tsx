// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';

const cfg = vi.hoisted(() => ({ foldableInnerDisplay: true }));

vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ foldableInnerDisplay: cfg.foldableInnerDisplay }),
}));
vi.mock('../HingeObserver', () => ({
  HingeObserver: () => createElement('div', { 'data-hinge-observer': 'true' }),
}));

import { FoldHingeObserver } from '../FoldHingeObserver';
import { publishHingeStatus, resetHingeStatusForTests, useHingePartiallyOpen } from '../../../lib/device-hinge-store';

describe('FoldHingeObserver', () => {
  beforeEach(() => {
    cfg.foldableInnerDisplay = true;
    resetHingeStatusForTests();
  });

  it('observes only on the inner display', () => {
    cfg.foldableInnerDisplay = false;
    const view = render(createElement(FoldHingeObserver));
    expect(view.container.querySelector('[data-hinge-observer="true"]')).toBeNull();
    cfg.foldableInnerDisplay = true;
    view.rerender(createElement(FoldHingeObserver));
    expect(view.container.querySelector('[data-hinge-observer="true"]')).not.toBeNull();
  });

  it('resets to flat when the Duo closes, so a fold from half open to closed leaves nothing stale', () => {
    const view = render(createElement(FoldHingeObserver));
    const { result } = renderHook(() => useHingePartiallyOpen());
    act(() => publishHingeStatus('partiallyOpen'));
    expect(result.current).toBe(true);

    cfg.foldableInnerDisplay = false;
    act(() => view.rerender(createElement(FoldHingeObserver)));
    expect(result.current).toBe(false);
  });
});
