import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_RECEIPT_MAX_AGE_MS,
  clearRelayReceipt,
  noteOwnMove,
  noteRelayReceipt,
  takeRelayReceipt,
} from '../relay-receipt';

describe('relay receipt (#7014)', () => {
  beforeEach(() => {
    clearRelayReceipt();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands a change of current climb to the write for that item, once', () => {
    noteRelayReceipt({
      eventType: 'CurrentClimbChanged',
      incomingQueueItemUuid: 'queue-b',
      localQueueItemUuid: 'queue-a',
      correlationId: 'corr-1',
    });

    expect(takeRelayReceipt('queue-b')).toEqual({
      queueItemUuid: 'queue-b',
      eventType: 'CurrentClimbChanged',
      correlationId: 'corr-1',
      receivedAt: 1_000,
    });
    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('records nothing for the echo of this phone’s own move', () => {
    noteRelayReceipt({
      eventType: 'CurrentClimbChanged',
      incomingQueueItemUuid: 'queue-b',
      localQueueItemUuid: 'queue-b',
      correlationId: 'corr-self',
    });

    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  // #7039 review: the climber picks B then C before B's echo arrives. The echo
  // names B while C is current, so only its own-echo recognition keeps it out.
  it('records nothing for an echo the caller recognised as this phone’s own', () => {
    noteRelayReceipt({
      eventType: 'CurrentClimbChanged',
      incomingQueueItemUuid: 'queue-b',
      localQueueItemUuid: 'queue-c',
      correlationId: 'corr-self-b',
      ownEcho: true,
    });

    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('records nothing for a FullSync naming an item this phone just moved to', () => {
    noteOwnMove('queue-b');
    noteOwnMove('queue-c');

    // The now-slot echo of the B open: no correlation id, C is current.
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-c' });

    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('counts the same item again once this phone’s own move is old', () => {
    noteOwnMove('queue-b');
    vi.spyOn(performance, 'now').mockReturnValue(1_000 + RELAY_RECEIPT_MAX_AGE_MS + 1);

    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-c' });

    expect(takeRelayReceipt('queue-b')).toMatchObject({ queueItemUuid: 'queue-b' });
  });

  it('drops a pending crewmate receipt when this phone picks that item itself', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-a' });

    noteOwnMove('queue-b');

    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('records nothing when the event clears the current climb', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: null, localQueueItemUuid: 'queue-a' });

    expect(takeRelayReceipt('queue-a')).toBeNull();
  });

  it('drops a receipt the write reaches too late to be a relay', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-a' });

    vi.spyOn(performance, 'now').mockReturnValue(1_000 + RELAY_RECEIPT_MAX_AGE_MS + 1);

    expect(takeRelayReceipt('queue-b')).toBeNull();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('hands over a receipt right at the age limit', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-a' });

    vi.spyOn(performance, 'now').mockReturnValue(1_000 + RELAY_RECEIPT_MAX_AGE_MS);

    expect(takeRelayReceipt('queue-b')).toMatchObject({ queueItemUuid: 'queue-b' });
  });

  it('forgets the receipt when the session ends or the climber signs out', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-a' });

    clearRelayReceipt();

    expect(takeRelayReceipt('queue-b')).toBeNull();
  });

  it('keeps the receipt from a write for another item, and a newer event replaces it', () => {
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-b', localQueueItemUuid: 'queue-a' });
    expect(takeRelayReceipt('queue-a')).toBeNull();

    vi.spyOn(performance, 'now').mockReturnValue(2_000);
    noteRelayReceipt({ eventType: 'FullSync', incomingQueueItemUuid: 'queue-c', localQueueItemUuid: 'queue-b' });

    expect(takeRelayReceipt('queue-b')).toBeNull();
    expect(takeRelayReceipt('queue-c')).toEqual({
      queueItemUuid: 'queue-c',
      eventType: 'FullSync',
      correlationId: null,
      receivedAt: 2_000,
    });
  });
});
