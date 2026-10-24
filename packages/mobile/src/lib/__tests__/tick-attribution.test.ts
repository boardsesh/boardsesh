import { describe, expect, it } from 'vitest';
import { attributeTickToQueueItem } from '../tick-attribution';

describe('attributeTickToQueueItem', () => {
  it('counts a tick on the climb on the wall for its queue item', () => {
    expect(attributeTickToQueueItem('climb-1', { uuid: 'queue-1', climb: { uuid: 'climb-1' } })).toBe('queue-1');
  });

  it('counts a tick on any other climb for no queue item', () => {
    expect(attributeTickToQueueItem('climb-2', { uuid: 'queue-1', climb: { uuid: 'climb-1' } })).toBeNull();
  });

  it('counts no queue item with nothing on the wall', () => {
    expect(attributeTickToQueueItem('climb-1', null)).toBeNull();
  });
});
