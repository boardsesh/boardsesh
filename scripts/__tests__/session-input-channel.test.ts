import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { startInputObservationChannel } from '../lib/session-input-observation/channel';
import { singleTapFlow } from '../lib/session-input-observation/guards';
import {
  createInputTraceTransport,
  type InputTrace,
  type InputTraceCounters,
} from '../../packages/mobile/src/lib/native-input-transport';
const channels: Awaited<ReturnType<typeof startInputObservationChannel>>[] = [];
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close();
});
async function fixture(role = 'session-visibility') {
  const channel = await startInputObservationChannel();
  channels.push(channel);
  channel.beginLaunch();
  let sequence = 0;
  const send = async (
    fields: Record<string, unknown>[],
    counters: Partial<InputTraceCounters> = {},
    runtimeId = 'runtime-1',
  ) => {
    const events = fields.map((event) => ({ runtimeId, sourceSequence: ++sequence, ...event }));
    return fetch(channel.traceUrl, {
      method: 'POST',
      body: JSON.stringify({
        runtimeId,
        events,
        counters: { sourceSequence: sequence, queueDepth: 0, dropped: 0, errors: 0, ...counters },
      }),
    });
  };
  await fetch(channel.readinessUrl + '?runtimeId=runtime-1');
  await send([
    { stage: 'pre-session-mounted', componentId: 'parent-1' },
    { stage: 'pre-session-state-committed', componentId: 'parent-1', isPublic: true, isStartPending: false },
    { stage: 'switch-row-mounted', componentId: 'row-1', parentId: 'parent-1', semanticRole: role },
    {
      stage: 'switch-row-props-committed',
      componentId: 'row-1',
      parentId: 'parent-1',
      semanticRole: role,
      value: true,
      disabled: false,
    },
  ]);
  const ack = async (challenge: string, counters: Partial<InputTraceCounters> = {}) => {
    if (challenge.startsWith('window')) channel.closeWindow(challenge);
    else channel.requestAcknowledgement(challenge);
    await send([{ stage: 'trace-window-ack', challengeId: challenge }], counters);
  };
  return { channel, send, ack };
}
describe('independent finite observation channel', () => {
  it('completes real HTTP baseline and post-window acknowledgements with the app transport', async () => {
    const channel = await startInputObservationChannel();
    channels.push(channel);
    channel.beginLaunch();
    const source = createInputTraceTransport({ runtimeId: 'real-runtime', url: channel.traceUrl });
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 2000;
      while (!predicate()) {
        if (Date.now() > deadline) throw Error('test_channel_timeout');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await fetch(channel.readinessUrl + '?runtimeId=real-runtime');
      source.emit({ stage: 'pre-session-mounted', componentId: 'parent-1' });
      source.emit({
        stage: 'pre-session-state-committed',
        componentId: 'parent-1',
        isPublic: true,
        isStartPending: false,
      });
      source.emit({
        stage: 'switch-row-mounted',
        componentId: 'row-1',
        parentId: 'parent-1',
        semanticRole: 'session-visibility',
      });
      source.emit({
        stage: 'switch-row-props-committed',
        componentId: 'row-1',
        parentId: 'parent-1',
        semanticRole: 'session-visibility',
        value: true,
        disabled: false,
      });
      await wait(() => channel.snapshot().traceCount === 4);
      channel.requestAcknowledgement('baseline-real');
      source.emit({ stage: 'diagnostic-heartbeat' });
      await wait(() => channel.acknowledged('baseline-real'));
      channel.freezeBaseline('baseline-real');
      channel.closeWindow('window-real');
      source.emit({ stage: 'diagnostic-heartbeat' });
      await wait(() => channel.acknowledged('window-real'));
      expect(() => channel.finishWindow('window-real')).not.toThrow();
      expect(channel.snapshot().counters).toMatchObject({ queueDepth: 0, dropped: 0, errors: 0 });
    } finally {
      source.close();
    }
  });

  it('accepts direct readiness without any Metro output and freezes the exact acknowledged ON target', async () => {
    const { channel, ack } = await fixture();
    expect(channel.homeReady()).toBe(true);
    await ack('baseline-1');
    expect(channel.acknowledged('baseline-1')).toBe(true);
    expect(channel.freezeBaseline('baseline-1')).toEqual({
      runtimeId: 'runtime-1',
      parentId: 'parent-1',
      switchRowId: 'row-1',
      sourceSequence: 5,
    });
    const harness = readFileSync('scripts/observe-session-input.ts', 'utf8');
    expect(harness).toContain('channel!.homeReady()');
    expect(harness).not.toContain('countHomeReady');
  });
  it('rejects stale readiness after fresh launch and never accepts an unrelated ON switch', async () => {
    const { channel } = await fixture('rest-timer');
    expect(() => channel.baseline()).toThrow('trace_transport_unverified');
    channel.beginLaunch();
    expect((await fetch(channel.readinessUrl + '?runtimeId=runtime-1')).status).toBe(409);
    expect(channel.homeReady()).toBe(false);
  });
  it('rejects missing, disabled and foreign-parent target baselines', async () => {
    const { channel, send } = await fixture();
    await send([
      {
        stage: 'switch-row-props-committed',
        componentId: 'row-1',
        parentId: 'foreign-parent',
        semanticRole: 'session-visibility',
        value: true,
        disabled: false,
      },
    ]);
    expect(() => channel.baseline()).toThrow();
    await send([
      {
        stage: 'switch-row-props-committed',
        componentId: 'row-1',
        parentId: 'parent-1',
        semanticRole: 'session-visibility',
        value: true,
        disabled: true,
      },
    ]);
    expect(() => channel.baseline()).toThrow();
    await send([{ stage: 'switch-row-unmounted', componentId: 'row-1' }]);
    expect(() => channel.baseline()).toThrow();
  });
  it('requires a fresh drained post-window acknowledgement and seals evidence against late healing', async () => {
    const { channel, ack, send } = await fixture();
    await ack('baseline-1');
    channel.freezeBaseline('baseline-1');
    await send([
      {
        stage: 'raw-wrapper',
        isOn: false,
        switchRowId: 'row-1',
        parentId: 'parent-1',
        semanticRole: 'session-visibility',
      },
    ]);
    channel.closeWindow('window-1');
    expect(() => channel.finishWindow('window-1')).toThrow();
    await send([{ stage: 'trace-window-ack', challengeId: 'baseline-1' }]);
    expect(channel.acknowledged('window-1')).toBe(false);
    await ack('window-1');
    const frozen = channel.finishWindow('window-1');
    expect(frozen.some((event) => event.stage === 'raw-wrapper')).toBe(true);
    expect((await send([{ stage: 'raw-wrapper', isOn: true }])).status).toBe(409);
    expect(channel.snapshot().latePackets).toBe(1);
    expect(frozen.filter((event) => event.stage === 'raw-wrapper')).toHaveLength(1);
  });
  it.each([{ errors: 1 }, { dropped: 1 }, { queueDepth: 1 }])(
    'fails closed on source counters %j',
    async (counters) => {
      const { channel, ack } = await fixture();
      await ack('baseline-1');
      channel.freezeBaseline('baseline-1');
      await ack('window-1', counters);
      expect(channel.acknowledged('window-1')).toBe(false);
      expect(() => channel.finishWindow('window-1')).toThrow('trace_transport_unverified');
    },
  );
  it('rejects source gaps while tolerating out-of-order packet arrival', async () => {
    const { channel } = await fixture();
    const post = async (events: InputTrace[], sourceSequence: number) =>
      fetch(channel.traceUrl, {
        method: 'POST',
        body: JSON.stringify({
          runtimeId: 'runtime-1',
          events,
          counters: { sourceSequence, queueDepth: 0, dropped: 0, errors: 0 },
        }),
      });
    channel.requestAcknowledgement('baseline-1');
    await post(
      [{ stage: 'trace-window-ack', runtimeId: 'runtime-1', sourceSequence: 6, challengeId: 'baseline-1' }],
      6,
    );
    expect(channel.acknowledged('baseline-1')).toBe(false);
    await post([{ stage: 'diagnostic-heartbeat', runtimeId: 'runtime-1', sourceSequence: 5 }], 5);
    expect(channel.acknowledged('baseline-1')).toBe(true);
  });
  it('rejects replaced/unmounted target instances even with a healthy transport ACK', async () => {
    const { channel, ack, send } = await fixture();
    await ack('baseline-1');
    channel.freezeBaseline('baseline-1');
    await send([
      { stage: 'switch-row-unmounted', componentId: 'row-1' },
      { stage: 'switch-row-mounted', componentId: 'row-2', parentId: 'parent-1', semanticRole: 'session-visibility' },
    ]);
    await ack('window-1');
    expect(() => channel.finishWindow('window-1')).toThrow('trace_transport_unverified');
  });
  it('rejects oversized, unknown-stage and user-payload packets without retaining their contents', async () => {
    const { channel, send } = await fixture();
    expect((await fetch(channel.traceUrl, { method: 'POST', body: 'x'.repeat(8193) })).status).toBe(413);
    expect((await send([{ stage: 'unknown', password: 'never-retained' }])).status).toBe(400);
    expect(JSON.stringify(channel.snapshot())).not.toContain('never-retained');
    expect(channel.snapshot().rejected).toBe(2);
  });
  it('never heals a window with a delayed application event', async () => {
    const { channel, ack, send } = await fixture();
    await ack('baseline-1');
    channel.freezeBaseline('baseline-1');
    channel.closeWindow('window-1');
    await send([{ stage: 'raw-wrapper', isOn: false }]);
    await ack('window-1');
    expect(() => channel.finishWindow('window-1')).toThrow('trace_transport_unverified');
    expect(channel.snapshot().lateApplicationEvents).toBe(1);
  });
  it('wires semantic target identities without changing native modifiers', () => {
    const row = readFileSync('packages/mobile/src/components/session-screen/SessionVisibilityRow.tsx', 'utf8');
    const parent = readFileSync('packages/mobile/src/components/session-screen/pre-session/PreSessionView.tsx', 'utf8');
    expect(row).toContain('diagnosticRole="session-visibility"');
    expect(row).toContain('diagnosticParentId={diagnosticParentId}');
    expect(parent).toContain('diagnosticParentId={diagnosticComponentId}');
  });
  it('makes a failed before hook stop Maestro before contact', () => {
    const commands = parse(singleTapFlow({ x: 369, y: 487 }).split('---\n')[1]) as { assertTrue?: string }[];
    const expression = commands[0].assertTrue?.slice(2, -1);
    expect(expression).toBeTruthy();
    expect(
      runInNewContext(expression!, { http: { get: () => ({ body: '{"error":"trace_transport_unverified"}' }) } }),
    ).toBe(false);
    expect(runInNewContext(expression!, { http: { get: () => ({ body: '{"ok":true}' }) } })).toBe(true);
  });
});
