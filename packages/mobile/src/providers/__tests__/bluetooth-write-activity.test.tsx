// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createBleWriteActivityStore } from '../../lib/ble/write-activity-store';
import {
  BluetoothWriteActivityProvider,
  getBleWriteActivityServerSnapshot,
  useBluetoothWriteInProgress,
} from '../bluetooth-write-activity';

function ActivityProbe({ onRender }: { onRender?: () => void }) {
  onRender?.();
  const isWriting = useBluetoothWriteInProgress();
  return createElement('span', { 'data-writing': String(isWriting) });
}

function PassiveSibling({ onRender }: { onRender: () => void }) {
  onRender();
  return createElement('span', { 'data-passive': 'true' });
}

describe('BluetoothWriteActivityProvider', () => {
  it('rerenders only the activity subscriber when the external store changes', () => {
    const store = createBleWriteActivityStore();
    const activityRender = vi.fn();
    const passiveRender = vi.fn();
    const view = render(
      createElement(
        BluetoothWriteActivityProvider,
        { store },
        createElement(ActivityProbe, { onRender: activityRender }),
        createElement(PassiveSibling, { onRender: passiveRender }),
      ),
    );

    expect(activityRender).toHaveBeenCalledTimes(1);
    expect(passiveRender).toHaveBeenCalledTimes(1);

    let release = () => {};
    act(() => {
      release = store.begin();
    });
    expect(view.container.querySelector('[data-writing="true"]')).toBeTruthy();
    expect(activityRender).toHaveBeenCalledTimes(2);
    expect(passiveRender).toHaveBeenCalledTimes(1);

    act(() => release());
    expect(view.container.querySelector('[data-writing="false"]')).toBeTruthy();
    expect(activityRender).toHaveBeenCalledTimes(3);
    expect(passiveRender).toHaveBeenCalledTimes(1);
  });

  it('is idle outside a provider and exposes an idle server snapshot', () => {
    const noProvider = render(createElement(ActivityProbe));
    expect(noProvider.container.querySelector('[data-writing="false"]')).toBeTruthy();
    expect(getBleWriteActivityServerSnapshot()).toBe(false);
  });
});
