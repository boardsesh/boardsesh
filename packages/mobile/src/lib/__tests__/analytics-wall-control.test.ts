import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../analytics', () => ({ track: trackMock }));

import { trackWallControlShown, trackWallControlTapped } from '../analytics-wall-control';

// 2.7: `previewReason` says why the climb on screen is a preview. It is left
// off, not sent as null, for the committed climb, so a breakdown by it has no
// empty bucket standing for "not a preview".
describe('wall control events', () => {
  beforeEach(() => trackMock.mockClear());

  it('Wall Control Shown carries the reason only for a preview', () => {
    trackWallControlShown({ state: 'put_on_wall', climbUuid: 'climb-1', previewReason: 'default' });
    trackWallControlShown({ state: 'connect', climbUuid: 'climb-2', previewReason: null });
    expect(trackMock.mock.calls).toEqual([
      ['Wall Control Shown', { state: 'put_on_wall', climbUuid: 'climb-1', previewReason: 'default' }],
      ['Wall Control Shown', { state: 'connect', climbUuid: 'climb-2' }],
    ]);
  });

  it('Wall Control Tapped carries the reason only for a preview, after the surface context', () => {
    trackWallControlTapped({
      state: 'put_on_wall',
      action: 'put_on_wall',
      control: 'button',
      analyticsContext: { surface: 'play_drawer' },
      previewReason: 'other_board',
    });
    trackWallControlTapped({ state: null, action: 'noop', control: 'bulb' });
    expect(trackMock.mock.calls).toEqual([
      [
        'Wall Control Tapped',
        {
          surface: 'play_drawer',
          state: 'put_on_wall',
          action: 'put_on_wall',
          control: 'button',
          previewReason: 'other_board',
        },
      ],
      ['Wall Control Tapped', { state: 'none', action: 'noop', control: 'bulb' }],
    ]);
  });
});
