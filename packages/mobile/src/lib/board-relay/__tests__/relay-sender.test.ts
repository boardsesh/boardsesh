// Relay mode (#7220): one relay, confirmed by the holder's echo of its id
// within RELAY_CONFIRM_TIMEOUT_MS, never retried.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItemInput, RelayBoardClimbResult } from '@boardsesh/shared-schema';
import { createRelaySender, RELAY_CONFIRM_TIMEOUT_MS, type RelaySendArgs } from '../relay-sender';

function climb(uuid: string): ClimbQueueItemInput {
  return { uuid: `q-${uuid}`, climb: { uuid } } as unknown as ClimbQueueItemInput;
}

function args(uuid: string): RelaySendArgs {
  return { boardId: 5, climb: climb(uuid), angle: 40, mirrored: false };
}

function harness(result: RelayBoardClimbResult | Error = { status: 'SENT', holder: null }) {
  const echoListeners = new Set<(id: string) => void>();
  let nextId = 0;
  const relayClimb = vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  const sender = createRelaySender({
    relayClimb,
    subscribeEchoes: (listener) => {
      echoListeners.add(listener);
      return () => echoListeners.delete(listener);
    },
    mintId: () => `relay-${++nextId}`,
  });
  const echo = (id: string) => {
    for (const listener of [...echoListeners]) listener(id);
  };
  return { sender, relayClimb, echo, echoListeners };
}

describe('createRelaySender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends with a fresh id and confirms on its echo', async () => {
    const { sender, relayClimb, echo, echoListeners } = harness();
    const outcome = sender.send(args('c1'));
    expect(relayClimb).toHaveBeenCalledWith({ ...args('c1'), relayRequestId: 'relay-1' });
    echo('someone-else');
    echo('relay-1');
    await expect(outcome).resolves.toEqual({ kind: 'confirmed', relayRequestId: 'relay-1', climbUuid: 'c1' });
    expect(echoListeners.size).toBe(0);
    expect(sender.isPending()).toBe(false);
  });

  it('confirms an echo that beats the mutation answer', async () => {
    const { sender, echo } = harness();
    const outcome = sender.send(args('c1'));
    echo('relay-1');
    await expect(outcome).resolves.toMatchObject({ kind: 'confirmed' });
  });

  it('times out at 8 s with no echo, and never retries', async () => {
    const { sender, relayClimb } = harness();
    const outcome = sender.send(args('c1'));
    await vi.advanceTimersByTimeAsync(RELAY_CONFIRM_TIMEOUT_MS - 1);
    expect(sender.isPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toEqual({ kind: 'unconfirmed', cause: 'timeout' });
    expect(relayClimb).toHaveBeenCalledTimes(1);
  });

  it('an echo after the timeout changes nothing', async () => {
    const { sender, echo } = harness();
    const outcome = sender.send(args('c1'));
    await vi.advanceTimersByTimeAsync(RELAY_CONFIRM_TIMEOUT_MS);
    echo('relay-1');
    await expect(outcome).resolves.toMatchObject({ kind: 'unconfirmed', cause: 'timeout' });
  });

  it.each(['NO_HOLDER', 'SELF_HOLDER', 'HOLDER_UNREACHABLE'])('%s: the holder is gone', async (status) => {
    const { sender } = harness({ status, holder: null } as unknown as RelayBoardClimbResult);
    await expect(sender.send(args('c1'))).resolves.toEqual({ kind: 'holder_gone', status });
  });

  it.each(['HOLDER_OPTED_OUT', 'NOT_RELAY_BOARD', 'CLIMB_UNAVAILABLE'])('%s: refused, unconfirmed', async (status) => {
    const { sender } = harness({ status, holder: null } as unknown as RelayBoardClimbResult);
    await expect(sender.send(args('c1'))).resolves.toEqual({ kind: 'unconfirmed', cause: 'refused', status });
  });

  it('a failed request is unconfirmed', async () => {
    const { sender } = harness(new Error('socket closed'));
    await expect(sender.send(args('c1'))).resolves.toEqual({ kind: 'unconfirmed', cause: 'error' });
  });

  it('a newer climb supersedes the one in flight', async () => {
    const { sender, echo } = harness();
    const first = sender.send(args('c1'));
    const second = sender.send(args('c2'));
    await expect(first).resolves.toEqual({ kind: 'superseded' });
    echo('relay-2');
    await expect(second).resolves.toMatchObject({ kind: 'confirmed', climbUuid: 'c2' });
  });

  it('the same climb already on its way is joined, not sent twice', async () => {
    const { sender, relayClimb } = harness();
    const first = sender.send(args('c1'));
    const second = sender.send(args('c1'));
    expect(second).toBe(first);
    expect(relayClimb).toHaveBeenCalledTimes(1);
  });

  it('cancel supersedes the relay in flight (the climber stopped)', async () => {
    const { sender } = harness();
    const outcome = sender.send(args('c1'));
    sender.cancel();
    await expect(outcome).resolves.toEqual({ kind: 'superseded' });
    await vi.advanceTimersByTimeAsync(RELAY_CONFIRM_TIMEOUT_MS);
    expect(sender.isPending()).toBe(false);
  });
});
