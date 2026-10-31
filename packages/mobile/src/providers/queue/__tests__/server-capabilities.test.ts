import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@boardsesh/graphql-client';

const graph = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: graph.execute }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

import { isAttributionValidationError, probeQueueServerCapabilities } from '../now-slot-server';

describe('queue attribution capabilities', () => {
  const client = {} as Client;
  const fields = (names: string[]) => ({ fields: names.map((name) => ({ name })) });
  beforeEach(() => {
    graph.execute.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('requires attribution on both state and events, independently of now-slot fields', async () => {
    graph.execute.mockResolvedValue({
      queueState: fields(['currentChangedBy']),
      currentClimbChanged: fields(['currentChangedBy']),
    });
    expect(await probeQueueServerCapabilities(client)).toEqual({ attribution: true, nowSlot: false });
  });

  it.each(['queueState', 'currentClimbChanged'])('fails closed when %s lacks attribution', async (missingType) => {
    graph.execute.mockResolvedValue({
      queueState: fields(['historyCount', 'currentChangedAt', 'currentChangedBy']),
      currentClimbChanged: fields(['currentChangedBy']),
      [missingType]: fields(['historyCount', 'currentChangedAt']),
    });
    expect((await probeQueueServerCapabilities(client)).attribution).toBe(false);
  });

  it('keeps both capabilities off when the probe fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    graph.execute.mockRejectedValue(new Error('offline'));
    expect(await probeQueueServerCapabilities(client)).toEqual({ attribution: false, nowSlot: false });
  });

  it('recognizes only field-validation failures for actor-free retries', () => {
    expect(isAttributionValidationError(new Error('Cannot query field "currentChangedBy" on type "QueueState".'))).toBe(
      true,
    );
    expect(isAttributionValidationError([{ message: 'Cannot query field "currentChangedBy".' }])).toBe(true);
    expect(isAttributionValidationError(new Error('Cannot query field "historyCount".'))).toBe(false);
    expect(isAttributionValidationError(new Error('currentChangedBy storage failed'))).toBe(false);
    expect(isAttributionValidationError(new Error('offline'))).toBe(false);
  });
});
