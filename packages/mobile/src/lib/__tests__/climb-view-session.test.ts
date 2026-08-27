import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRenderTelemetryProps } from '@boardsesh/analytics';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../analytics', () => ({ track: analyticsMocks.track }));

import {
  _resetClimbViewSessionForTests,
  markClimbAction,
  markClimbViewed,
  noteBoardPinch,
} from '../climb-view-session';

const COMMON_PROPS: BoardRenderTelemetryProps = {
  board_name: 'kilter',
  layout_id: 1,
  size_id: 2,
  render_mode: 'boardsesh',
  glow_falloff: 'plateau',
  glow_falloff_source: 'flag',
};

describe('climb-view-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetClimbViewSessionForTests();
    vi.useRealTimers();
  });

  describe('markClimbViewed', () => {
    it('fires Climb View Opened with reopened_in_session false on the first view', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Climb View Opened', {
        ...COMMON_PROPS,
        climb_uuid: 'climb-1',
        reopened_in_session: false,
      });
    });

    it('fires reopened_in_session true the second time the same climb is viewed', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-1', COMMON_PROPS);
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Climb View Opened', {
        ...COMMON_PROPS,
        climb_uuid: 'climb-1',
        reopened_in_session: true,
      });
    });

    it('tracks reopened state independently per climb', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbViewed('climb-2', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-2', COMMON_PROPS);
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb View Opened',
        expect.objectContaining({ climb_uuid: 'climb-2', reopened_in_session: true }),
      );
    });
  });

  describe('markClimbAction', () => {
    it('fires Climb First Action with ms_since_open once a viewed climb gets its first action', () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      vi.setSystemTime(1_000 + 4_200);
      markClimbAction('climb-1', 'ble');

      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Climb First Action', {
        ...COMMON_PROPS,
        climb_uuid: 'climb-1',
        action_type: 'ble',
        ms_since_open: 4_200,
      });
    });

    it('fires only once per view — a second action on the same view is a no-op', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbAction('climb-1', 'queue');
      analyticsMocks.track.mockClear();

      markClimbAction('climb-1', 'ble');
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('re-arms after the climb is viewed again', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbAction('climb-1', 'queue');
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();
      markClimbAction('climb-1', 'ble');

      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ action_type: 'ble' }),
      );
    });

    it('is a no-op for a climb that was never marked viewed', () => {
      markClimbAction('climb-never-viewed', 'queue');
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('carries the common props captured at view time, not at action time', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbAction('climb-1', 'queue');
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ board_name: 'kilter', render_mode: 'boardsesh' }),
      );
    });
  });

  describe('noteBoardPinch', () => {
    it('fires Board Pinch when the scale delta clears the gate', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 2.4, scaleDelta: 1.4 });
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Board Pinch', {
        ...COMMON_PROPS,
        scale_max: 2.4,
      });
    });

    it('does not fire below the minimum scale delta (0.15)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1.1, scaleDelta: 0.1 });
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('fires exactly at the gate boundary is exclusive (delta must clear, not just meet)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1.15, scaleDelta: 0.15 });
      expect(analyticsMocks.track).toHaveBeenCalledOnce();
    });

    it('gates on the absolute delta — a pinch-out (negative delta) counts too', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1, scaleDelta: -0.5 });
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Board Pinch', {
        ...COMMON_PROPS,
        scale_max: 1,
      });
    });
  });
});
