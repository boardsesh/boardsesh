import { describe, expect, it } from 'vitest';
import {
  anchorAfterFire,
  resolveEffectiveRestPacing,
  restAdvanceAllowed,
  type CrewRestConfig,
  type RestPacingSettings,
  type RestTimerStagePacing,
} from '../rest-timer-pacing';

const SETTINGS: RestPacingSettings = { targetSeconds: 120, mode: 'afterTick', autoAdvance: false };

const STAGE: RestTimerStagePacing = {
  sessionId: 'session-1',
  stageId: 'stage-limit',
  kind: 'volume',
  queueItemUuid: 'queue-1',
  mode: 'afterTick',
  targetSeconds: 180,
  advanceOn: 'send',
  closesSet: false,
  stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
};

const CREW: CrewRestConfig = {
  targetSeconds: 60,
  mode: 'onTheMinute',
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
  setByParticipantId: 'participant-sam',
};

describe('resolveEffectiveRestPacing', () => {
  it('passes the climber’s settings straight through, on the deadline as always', () => {
    expect(resolveEffectiveRestPacing({ settings: SETTINGS, stage: null, crew: null })).toEqual({
      targetSeconds: 120,
      mode: 'afterTick',
      autoAdvance: false,
      advanceOn: 'deadline',
      source: 'settings',
      stage: null,
    });
  });

  it('keeps an Off rest length Off', () => {
    const pacing = resolveEffectiveRestPacing({
      settings: { targetSeconds: null, mode: 'onTheMinute', autoAdvance: true },
      stage: null,
      crew: null,
    });
    expect(pacing).toMatchObject({ targetSeconds: null, mode: 'onTheMinute', autoAdvance: true });
  });

  it('lets a workout stage pace the timer, always hands-free', () => {
    expect(resolveEffectiveRestPacing({ settings: SETTINGS, stage: STAGE, crew: null })).toEqual({
      targetSeconds: 180,
      mode: 'afterTick',
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
      stage: STAGE,
    });
  });

  it('puts the crew clock above both, keeping the local stage for display', () => {
    expect(resolveEffectiveRestPacing({ settings: SETTINGS, stage: STAGE, crew: CREW })).toEqual({
      targetSeconds: 60,
      mode: 'onTheMinute',
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'crew',
      stage: STAGE,
    });
  });

  it('takes the crew’s own auto-advance, off included', () => {
    const pacing = resolveEffectiveRestPacing({
      settings: SETTINGS,
      stage: null,
      crew: { ...CREW, autoAdvance: false },
    });
    expect(pacing).toMatchObject({ source: 'crew', autoAdvance: false, stage: null });
  });
});

describe('restAdvanceAllowed', () => {
  it('always lets the deadline advance', () => {
    expect(restAdvanceAllowed({ advanceOn: 'deadline', currentQueueItemUuid: null, lastTick: null })).toBe(true);
  });

  describe('a climb the timer already moved the wall off', () => {
    const tickOnTheWall = { status: 'send' as const, queueItemUuid: 'queue-1' };

    it('never moves on again from it on the same tick, under either tick rule', () => {
      for (const advanceOn of ['tick', 'send'] as const) {
        expect(
          restAdvanceAllowed({
            advanceOn,
            currentQueueItemUuid: 'queue-1',
            lastTick: tickOnTheWall,
            advancedFromQueueItemUuid: 'queue-1',
          }),
        ).toBe(false);
      }
    });

    it('still moves on from any other climb, and on the deadline', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'send',
          currentQueueItemUuid: 'queue-1',
          lastTick: tickOnTheWall,
          advancedFromQueueItemUuid: 'queue-0',
        }),
      ).toBe(true);
      expect(
        restAdvanceAllowed({
          advanceOn: 'deadline',
          currentQueueItemUuid: 'queue-1',
          lastTick: tickOnTheWall,
          advancedFromQueueItemUuid: 'queue-1',
        }),
      ).toBe(true);
    });
  });

  describe('tick', () => {
    it('advances after a tick on the climb on the wall', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'tick',
          currentQueueItemUuid: 'queue-1',
          lastTick: { status: 'attempt', queueItemUuid: 'queue-1' },
        }),
      ).toBe(true);
    });

    it('does not advance with no tick yet', () => {
      expect(restAdvanceAllowed({ advanceOn: 'tick', currentQueueItemUuid: 'queue-1', lastTick: null })).toBe(false);
    });

    it('does not advance on a tick logged against another climb', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'tick',
          currentQueueItemUuid: 'queue-2',
          lastTick: { status: 'send', queueItemUuid: 'queue-1' },
        }),
      ).toBe(false);
    });

    it('does not advance on a tick with no queue item, or with nothing on the wall', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'tick',
          currentQueueItemUuid: 'queue-1',
          lastTick: { status: 'send', queueItemUuid: null },
        }),
      ).toBe(false);
      expect(
        restAdvanceAllowed({
          advanceOn: 'tick',
          currentQueueItemUuid: null,
          lastTick: { status: 'send', queueItemUuid: null },
        }),
      ).toBe(false);
    });
  });

  describe('send', () => {
    it.each(['flash', 'send'] as const)('advances after a %s on the climb on the wall', (status) => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'send',
          currentQueueItemUuid: 'queue-1',
          lastTick: { status, queueItemUuid: 'queue-1' },
        }),
      ).toBe(true);
    });

    it('does not advance after an attempt: the climber is still on their limit climb', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'send',
          currentQueueItemUuid: 'queue-1',
          lastTick: { status: 'attempt', queueItemUuid: 'queue-1' },
        }),
      ).toBe(false);
    });

    it('does not advance on a send of another climb', () => {
      expect(
        restAdvanceAllowed({
          advanceOn: 'send',
          currentQueueItemUuid: 'queue-2',
          lastTick: { status: 'send', queueItemUuid: 'queue-1' },
        }),
      ).toBe(false);
    });
  });
});

describe('anchorAfterFire', () => {
  it('restarts an after-tick rest at the fire, as the timer always has', () => {
    expect(anchorAfterFire({ mode: 'afterTick', advanceOn: 'deadline' })).toBe('now');
  });

  it('keeps the beat on the minute, whatever the rule', () => {
    expect(anchorAfterFire({ mode: 'onTheMinute', advanceOn: 'deadline' })).toBe('keep');
    expect(anchorAfterFire({ mode: 'onTheMinute', advanceOn: 'tick' })).toBe('keep');
  });

  it.each(['tick', 'send'] as const)('waits for the next tick under the %s rule', (advanceOn) => {
    expect(anchorAfterFire({ mode: 'afterTick', advanceOn })).toBe('clear');
  });
});
