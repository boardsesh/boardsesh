import { describe, expect, it } from 'vitest';
import { attributeTickToQueueItem, type TickAttributionCandidate } from '../tick-attribution';

const ON_THE_WALL: TickAttributionCandidate = { uuid: 'queue-1', climb: { uuid: 'climb-1', angle: 40 } };

describe('attributeTickToQueueItem', () => {
  it('counts a tick on the climb on the wall, at its angle, for its queue item', () => {
    expect(attributeTickToQueueItem({ climbUuid: 'climb-1', angle: 40 }, ON_THE_WALL)).toBe('queue-1');
  });

  it('counts a tick on any other climb for no queue item', () => {
    expect(attributeTickToQueueItem({ climbUuid: 'climb-2', angle: 40 }, ON_THE_WALL)).toBeNull();
  });

  it('counts a tick on the climb on the wall at another angle for no queue item', () => {
    expect(attributeTickToQueueItem({ climbUuid: 'climb-1', angle: 30 }, ON_THE_WALL)).toBeNull();
  });

  it('counts no tick for a queue item with no usable angle', () => {
    const withoutAngle = { uuid: 'queue-1', climb: { uuid: 'climb-1' } } as unknown as TickAttributionCandidate;
    const withNaN: TickAttributionCandidate = { uuid: 'queue-1', climb: { uuid: 'climb-1', angle: Number.NaN } };

    expect(attributeTickToQueueItem({ climbUuid: 'climb-1', angle: 40 }, withoutAngle)).toBeNull();
    expect(attributeTickToQueueItem({ climbUuid: 'climb-1', angle: Number.NaN }, withNaN)).toBeNull();
  });

  it('counts no queue item with nothing on the wall', () => {
    expect(attributeTickToQueueItem({ climbUuid: 'climb-1', angle: 40 }, null)).toBeNull();
  });
});
