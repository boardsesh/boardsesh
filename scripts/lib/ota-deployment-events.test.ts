import { describe, expect, it, vi } from 'vitest';
import {
  deploymentFailureReason,
  deliverDeploymentEvents,
  emptyDeploymentOutbox,
  parseDeploymentOutbox,
  queueDeploymentEvent,
} from './ota-deployment-events';
import { initialStableState, parseStableState } from './ota-stable';

describe('durable deployment notifications', () => {
  it('keeps credential-bearing API response bodies out of failure messages', () => {
    expect(
      deploymentFailureReason('tick', new Error('Admin login failed (HTTP 401): password=hunter2 token=secret')),
    ).toBe('tick failed (HTTP 401); inspect the Actions run. Confirmed platform changes are reported separately.');
  });
  it('reads legacy v1 checkpoints and preserves outboxes across checkpoint recovery', () => {
    expect(parseStableState(initialStableState())).toEqual(initialStableState());
    const notifications = emptyDeploymentOutbox();
    queueDeploymentEvent(notifications, { kind: 'qa-passed', branch: 'production', commit: 'a'.repeat(40) }, 'qa-a');
    expect(
      parseStableState(JSON.parse(JSON.stringify({ ...initialStableState(), notifications })) as unknown).notifications,
    ).toEqual(notifications);
  });
  it('suppresses pending and delivered duplicates, but keeps another platform transition', async () => {
    const outbox = emptyDeploymentOutbox();
    const ios = { kind: 'rollout-increased' as const, branch: 'production', platform: 'ios' as const, percentage: 25 };
    queueDeploymentEvent(outbox, ios, 'ios-25');
    queueDeploymentEvent(outbox, ios, 'ios-25');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await deliverDeploymentEvents({ outbox, webhook: 'https://discord.test/webhook', save: vi.fn(), fetcher });
    queueDeploymentEvent(outbox, ios, 'ios-25');
    queueDeploymentEvent(outbox, { ...ios, platform: 'android' }, 'android-25');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(outbox.pending.map((event) => event.platform)).toEqual(['android']);
    const postedBody = fetcher.mock.calls[0][1]?.body;
    if (typeof postedBody !== 'string') throw new Error('Expected a JSON webhook request.');
    expect(JSON.parse(postedBody)).toMatchObject({ allowed_mentions: { parse: [] } });
  });
  it('persists each successful sibling and retries only the pending event after webhook failure', async () => {
    const outbox = emptyDeploymentOutbox();
    for (const platform of ['ios', 'android'] as const)
      queueDeploymentEvent(
        outbox,
        { kind: 'rollout-finished', branch: 'production', platform, percentage: 100 },
        platform,
      );
    let persisted = '';
    const save = () => {
      persisted = JSON.stringify(outbox);
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      deliverDeploymentEvents({ outbox, webhook: 'https://discord.test/webhook', save, fetcher }),
    ).rejects.toThrow('503');
    const restored = parseDeploymentOutbox(JSON.parse(persisted) as unknown);
    expect(restored.pending.map((event) => event.platform)).toEqual(['android']);
    expect(restored.sent).toHaveLength(1);
    const retry = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await deliverDeploymentEvents({
      outbox: restored,
      webhook: 'https://discord.test/webhook',
      save: vi.fn(),
      fetcher: retry,
    });
    expect(retry).toHaveBeenCalledOnce();
    expect(restored.pending).toEqual([]);
  });
  it('keeps queued events when the webhook is missing and never messages scratch proofs', async () => {
    const outbox = emptyDeploymentOutbox();
    queueDeploymentEvent(outbox, { kind: 'rollout-finished', branch: 'pr-rollout-proof', percentage: 100 }, 'proof');
    queueDeploymentEvent(outbox, { kind: 'train-cut', branch: 'release/next', version: '1.4.0' }, 'retired');
    expect(outbox.pending).toEqual([]);
    queueDeploymentEvent(outbox, { kind: 'candidate-frozen', branch: 'main', version: '1.4.0' }, 'candidate');
    await expect(deliverDeploymentEvents({ outbox, webhook: undefined, save: vi.fn() })).rejects.toThrow(
      'remain pending',
    );
    expect(outbox.pending).toHaveLength(1);
  });
});
