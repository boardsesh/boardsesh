import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import BoardLitupHolds from '../board-litup-holds';
import type { HoldRenderData, LitUpHoldsMap } from '../types';

const holdsData: HoldRenderData[] = [{ id: 1, mirroredHoldId: null, cx: 100, cy: 200, r: 20 }];

describe('BoardLitupHolds', () => {
  it('issue #2202: prefers the calibrated displayColor over the raw LED color for a lit hold', () => {
    // Not the raw LED color '#0000FF' — that's far too dark against a busy
    // board photo (issue #2202). The LED color is only correct for driving
    // physical board hardware over BLE, not for what a viewer sees on screen.
    const litUpHoldsMap: LitUpHoldsMap = {
      1: { state: 'HAND', color: '#0000FF', displayColor: '#4455FF' },
    };

    const { container } = render(
      <svg>
        <BoardLitupHolds holdsData={holdsData} litUpHoldsMap={litUpHoldsMap} mirrored={false} />
      </svg>,
    );

    const circle = container.querySelector('circle#hold-1');
    expect(circle?.getAttribute('stroke')).toBe('#4455FF');
  });

  it('falls back to the raw color when a board has no displayColor (e.g. Kilter)', () => {
    const litUpHoldsMap: LitUpHoldsMap = {
      1: { state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' },
    };

    const { container } = render(
      <svg>
        <BoardLitupHolds holdsData={holdsData} litUpHoldsMap={litUpHoldsMap} mirrored={false} />
      </svg>,
    );

    const circle = container.querySelector('circle#hold-1');
    expect(circle?.getAttribute('stroke')).toBe('#00FFFF');
  });

  it('renders transparent for a hold that is not lit up', () => {
    const litUpHoldsMap: LitUpHoldsMap = {};

    const { container } = render(
      <svg>
        <BoardLitupHolds holdsData={holdsData} litUpHoldsMap={litUpHoldsMap} mirrored={false} onHoldClick={() => {}} />
      </svg>,
    );

    const circle = container.querySelector('circle#hold-1');
    expect(circle?.getAttribute('stroke')).toBe('transparent');
  });
});
