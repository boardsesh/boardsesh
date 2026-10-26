// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { createElement } from 'react';

const cfg = vi.hoisted(() => ({ phoneSplit: true }));

vi.mock('../../../hooks/use-phone-split', () => ({ usePhoneSplit: () => cfg.phoneSplit }));
vi.mock('../HingeObserver', () => ({
  HingeObserver: () => createElement('div', { 'data-hinge-observer': 'true' }),
}));

import { PhoneSplitHingeObserver } from '../PhoneSplitHingeObserver';
import { publishHingeStatus, resetHingeStatusForTests, useHingePartiallyOpen } from '../../../lib/device-hinge-store';

describe('PhoneSplitHingeObserver', () => {
  beforeEach(() => {
    cfg.phoneSplit = true;
    resetHingeStatusForTests();
  });

  it('observes only while the split is up', () => {
    cfg.phoneSplit = false;
    const view = render(createElement(PhoneSplitHingeObserver));
    expect(view.container.querySelector('[data-hinge-observer="true"]')).toBeNull();
    cfg.phoneSplit = true;
    view.rerender(createElement(PhoneSplitHingeObserver));
    expect(view.container.querySelector('[data-hinge-observer="true"]')).not.toBeNull();
  });

  it('resets to flat when the split goes, so a fold from half open to closed leaves nothing stale', () => {
    const view = render(createElement(PhoneSplitHingeObserver));
    const { result } = renderHook(() => useHingePartiallyOpen());
    act(() => publishHingeStatus('partiallyOpen'));
    expect(result.current).toBe(true);

    cfg.phoneSplit = false;
    act(() => view.rerender(createElement(PhoneSplitHingeObserver)));
    expect(result.current).toBe(false);
  });
});
