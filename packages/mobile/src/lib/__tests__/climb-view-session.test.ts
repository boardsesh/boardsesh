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
  glow_falloff_source: 'user',
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
        // A boardsesh render whose falloff came from the flag is also the
        // experiment's exposure — see board-render-events.ts.
      });
    });

    it('fires reopened_in_session true when the climber comes back to a climb', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbViewed('climb-2', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-1', COMMON_PROPS);
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb View Opened',
        expect.objectContaining({ climb_uuid: 'climb-1', reopened_in_session: true }),
      );
    });

    // Two reporters call markClimbViewed — the queue provider's current-climb
    // effect and the play drawer's preview latch — and they overlap when a
    // previewed climb is committed to the queue. Nothing new is drawn, so
    // nothing new is reported.
    it('is a no-op when the climb already open is reported again', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-1', COMMON_PROPS);
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('does not reset ms_since_open when the open climb is reported again', () => {
      vi.useFakeTimers();
      markClimbViewed('climb-1', COMMON_PROPS);
      vi.advanceTimersByTime(5_000);
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbAction('climb-1', 'queue');
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ ms_since_open: 5_000 }),
      );
    });

    it('keeps the per-app-run reopened Set across an intervening climb', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbViewed('climb-2', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbViewed('climb-1', COMMON_PROPS);
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb View Opened',
        expect.objectContaining({ climb_uuid: 'climb-1', reopened_in_session: true }),
      );
    });
  });

  describe('markClimbAction', () => {
    it('fires Climb First Action with ms_since_open once a viewed climb gets its first action', () => {
      vi.useFakeTimers();
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      vi.advanceTimersByTime(4_200);
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

    it('re-arms once the climber leaves the climb and comes back to it', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbAction('climb-1', 'queue');
      markClimbViewed('climb-2', COMMON_PROPS);
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

  describe('only one view is ever open', () => {
    it('closes the previous climb view when a new climb is viewed', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbViewed('climb-2', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbAction('climb-1', 'queue');
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('still actions the climb that IS open', () => {
      markClimbViewed('climb-1', COMMON_PROPS);
      markClimbViewed('climb-2', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      markClimbAction('climb-2', 'queue');
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ climb_uuid: 'climb-2' }),
      );
    });

    // The regression this rule exists for: view climb X, browse for twenty
    // minutes, then tap X again under Similar Climbs — where addToQueue runs
    // BEFORE setCurrentClimb. A per-climb view map answered that queue add with
    // the twenty-minute-old view and reported ms_since_open: ~1_200_000.
    it('never measures ms_since_open from a view the climber left long ago', () => {
      vi.useFakeTimers();
      markClimbViewed('climb-x', COMMON_PROPS);
      vi.advanceTimersByTime(1_200_000);
      markClimbViewed('climb-y', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      // The Similar Climbs tap: the queue add lands while climb-y is still the
      // open view, so it matches nothing.
      markClimbAction('climb-x', 'queue');
      expect(analyticsMocks.track).not.toHaveBeenCalled();

      // Then setCurrentClimb opens a fresh view for climb-x, and an action on
      // it is measured from THAT moment.
      markClimbViewed('climb-x', COMMON_PROPS);
      analyticsMocks.track.mockClear();
      vi.advanceTimersByTime(2_500);
      markClimbAction('climb-x', 'ble');

      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ ms_since_open: 2_500 }),
      );
    });
  });

  describe('the view clock', () => {
    // Date.now() is wall-clock: an NTP correction mid-session moves it, and a
    // backwards jump would emit a negative ms_since_open. performance.now() is
    // monotonic, so a system-time jump has to leave the measurement alone.
    it('is monotonic — a backwards system-clock jump does not change ms_since_open', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
      markClimbViewed('climb-1', COMMON_PROPS);
      analyticsMocks.track.mockClear();

      vi.advanceTimersByTime(3_000);
      vi.setSystemTime(new Date('2026-08-27T11:00:00.000Z'));
      markClimbAction('climb-1', 'queue');

      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith(
        'Climb First Action',
        expect.objectContaining({ ms_since_open: 3_000 }),
      );
    });
  });

  describe('noteBoardPinch', () => {
    it('fires Board Pinch with the extremes and the signed delta when it clears the gate', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 2.4, scaleMin: 1, scaleDelta: 1.4 });
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Board Pinch', {
        ...COMMON_PROPS,
        scale_max: 2.4,
        scale_min: 1,
        scale_delta: 1.4,
      });
    });

    it('does not fire below the minimum scale delta (0.15)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1.1, scaleMin: 1, scaleDelta: 0.1 });
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('fires exactly at the gate boundary (the delta must meet 0.15, not exceed it)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1.15, scaleMin: 1, scaleDelta: 0.15 });
      expect(analyticsMocks.track).toHaveBeenCalledOnce();
    });

    it('fires exactly at the negative gate boundary (zoom-out magnitude must meet 0.15, not exceed it)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1, scaleMin: 0.85, scaleDelta: -0.15 });
      expect(analyticsMocks.track).toHaveBeenCalledOnce();
    });

    it('does not fire just short of the negative gate boundary (-0.14)', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 1, scaleMin: 0.86, scaleDelta: -0.14 });
      expect(analyticsMocks.track).not.toHaveBeenCalled();
    });

    it('counts a zoom-out: the delta is negative and clears the gate on magnitude', () => {
      noteBoardPinch(COMMON_PROPS, { scaleMax: 2.5, scaleMin: 1.2, scaleDelta: -1.3 });
      expect(analyticsMocks.track).toHaveBeenCalledExactlyOnceWith('Board Pinch', {
        ...COMMON_PROPS,
        scale_max: 2.5,
        scale_min: 1.2,
        scale_delta: -1.3,
      });
    });
  });
});
