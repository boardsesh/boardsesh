import { afterEach, expect, it, vi } from 'vitest';
import type { InputTraceRequest } from '../native-input-transport';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete globalThis.__boardseshNativeInputRawEvent;
});
it('keeps the actual diagnostic transport healthy across pre-session cleanup and remount', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.stubGlobal('__DEV__', true);
  vi.stubEnv('EXPO_PUBLIC_NATIVE_INPUT_TRACE', '1');
  vi.stubEnv('EXPO_PUBLIC_NATIVE_INPUT_TRACE_URL', 'http://127.0.0.1/trace');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const packets: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<InputTraceRequest>(async (_url, init) => {
      packets.push(init.body);
      return new Response('{}');
    }),
  );
  const native = await import('../native-input-diagnostic');
  const stopFirst = native.startNativeInputHeartbeat('parent-1');
  native.traceNativeInput('pre-session-mounted', { componentId: 'parent-1' });
  await vi.advanceTimersByTimeAsync(0);
  native.traceNativeInput('pre-session-unmounted', { componentId: 'parent-1' });
  stopFirst();
  const stopSecond = native.startNativeInputHeartbeat('parent-2');
  native.traceNativeInput('pre-session-mounted', { componentId: 'parent-2' });
  await vi.advanceTimersByTimeAsync(1000);
  stopSecond();
  expect(packets.join('')).toContain('pre-session-unmounted');
  expect(packets.join('')).toContain('parent-2');
  expect(
    packets
      .map((packet) => JSON.parse(packet).counters)
      .every((counters) => counters.dropped === 0 && counters.errors === 0),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
