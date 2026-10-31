import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInputTraceTransport, type InputTraceRequest } from '../native-input-transport';
const trace = vi.hoisted(() => vi.fn());
vi.mock('../native-input-diagnostic', () => ({ traceNativeInput: trace }));
vi.mock('../haptics', () => ({ hapticSelection: vi.fn() }));
import { makeToggleHandler } from '../../components/SwitchRow.logic';
const transports: ReturnType<typeof createInputTraceTransport>[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  trace.mockReset();
});
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function transport(options: Partial<Parameters<typeof createInputTraceTransport>[0]> = {}) {
  const instance = createInputTraceTransport({
    runtimeId: 'runtime-1',
    url: 'http://127.0.0.1/trace',
    request: vi.fn(async () => new Response('{}')),
    ...options,
  });
  transports.push(instance);
  return instance;
}
describe('nonblocking native input diagnostic transport', () => {
  it('rejects oversized serialized packets locally and records the lost event', async () => {
    const request = vi.fn<InputTraceRequest>(async () => new Response('{}'));
    const instance = transport({ request, serialize: () => 'x'.repeat(8193) });
    instance.emit({ stage: 'raw-wrapper' });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).not.toHaveBeenCalled();
    expect(instance.counters()).toMatchObject({ errors: 1, dropped: 1 });
  });
  it('strips unapproved fields and returns the challenge with source counters', async () => {
    const packets: string[] = [];
    const instance = transport({
      request: vi.fn<InputTraceRequest>(async (_url, init) => {
        packets.push(init.body);
        return new Response(JSON.stringify({ challengeId: 'window-1' }));
      }),
    });
    instance.emit({ stage: 'raw-wrapper', isOn: false, password: 'private-payload', label: 'person-name' });
    await vi.advanceTimersByTimeAsync(0);
    expect(packets.length).toBe(2);
    expect(packets.join('')).not.toMatch(/private-payload|person-name|password|label/);
    const packet = JSON.parse(packets[1]);
    expect(packet.events[0]).toMatchObject({ stage: 'trace-window-ack', challengeId: 'window-1', sourceSequence: 2 });
    expect(packet.counters).toEqual({ sourceSequence: 2, queueDepth: 0, dropped: 0, errors: 0 });
  });
  it.each(['reject', 'hang', 'serialize', 'enqueue'] as const)(
    'preserves actual haptic and parent exceptions when diagnostics %s',
    async (mode) => {
      const instance = transport({
        request:
          mode === 'reject'
            ? vi.fn(async () => {
                throw Error('network');
              })
            : mode === 'hang'
              ? vi.fn(() => new Promise<Response>(() => {}))
              : undefined,
        serialize:
          mode === 'serialize'
            ? () => {
                throw Error('serialization');
              }
            : undefined,
      });
      trace.mockImplementation((stage: string, fields: Record<string, unknown> = {}) =>
        instance.emit(
          mode === 'enqueue'
            ? new Proxy(
                {},
                {
                  get() {
                    throw Error('enqueue');
                  },
                },
              )
            : { stage, ...fields },
        ),
      );
      const hapticError = Error('actual-haptic-error'),
        parentError = Error('actual-parent-error');
      const parent = vi.fn();
      expect(() =>
        makeToggleHandler(parent, false, () => {
          throw hapticError;
        })(false),
      ).toThrow(hapticError);
      expect(parent).not.toHaveBeenCalled();
      expect(() =>
        makeToggleHandler(
          () => {
            throw parentError;
          },
          false,
          () => {},
        )(false),
      ).toThrow(parentError);
      await vi.advanceTimersByTimeAsync(1100);
      expect(instance.counters().errors).toBeGreaterThan(0);
    },
  );
  it('fails closed on enqueue scheduling throws and queue overflow', () => {
    const instance = transport();
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {
      throw Error('scheduling');
    });
    expect(() => instance.emit({ stage: 'raw-wrapper' })).not.toThrow();
    expect(instance.counters().errors).toBe(1);
    for (let index = 0; index < 150; index++) instance.emit({ stage: 'raw-wrapper' });
    expect(instance.counters().dropped).toBeGreaterThan(0);
  });
  it('cleans heartbeat and hanging-request timers on unmount', async () => {
    const instance = transport({ request: vi.fn(() => new Promise<Response>(() => {})) });
    instance.startHeartbeat(() => ({ componentId: 'parent-1' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    instance.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('counts rejected HTTP responses and heartbeat field errors', async () => {
    const instance = transport({ request: vi.fn(async () => new Response('{}', { status: 400 })) });
    instance.emit({ stage: 'raw-wrapper' });
    await vi.advanceTimersByTimeAsync(0);
    expect(instance.counters().errors).toBe(1);
    instance.startHeartbeat(() => {
      throw Error('diagnostic-field-error');
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(instance.counters().errors).toBe(2);
  });
});
