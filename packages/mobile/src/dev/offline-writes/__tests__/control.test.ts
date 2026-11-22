import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQaRuntimeReload, parseQaHostCommand, startQaCommandPolling } from '../control';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const command = { runId: 'control-test', phase: 'prepare-reload', receiptPort: 8096, rows: 1000 };
const originalRuntimeId = '11111111-1111-4111-8111-111111111111';
const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';

describe('native QA loopback commands', () => {
  it('reloads the targeted holding runtime once across repeated commands and a route remount', () => {
    const reload = vi.fn();
    const requestReload = createQaRuntimeReload(originalRuntimeId, reload);
    const targeted = parseQaHostCommand({ ...command, reloadRuntimeId: originalRuntimeId }, 8096);
    requestReload(undefined);
    requestReload({ ...targeted, phase: 'contention' });
    requestReload({ ...targeted, reloadRuntimeId: replacementRuntimeId });
    expect(reload).not.toHaveBeenCalled();
    requestReload(targeted);
    // The screen keeps the same module-scoped receiver across route mounts.
    requestReload({ ...targeted });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lets the replacement runtime retain preparation without reloading for an old target', () => {
    const reload = vi.fn();
    const receiveInReplacement = createQaRuntimeReload(replacementRuntimeId, reload);
    const targeted = parseQaHostCommand({ ...command, reloadRuntimeId: originalRuntimeId }, 8096);
    receiveInReplacement(targeted);
    expect(targeted.phase).toBe('prepare-reload');
    expect(reload).not.toHaveBeenCalled();
    receiveInReplacement({ ...targeted, runId: 'second-run', reloadRuntimeId: replacementRuntimeId });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed reload identities and requests outside the holding phase', () => {
    for (const reloadRuntimeId of ['', 'other-runtime', 123, null]) {
      expect(() => parseQaHostCommand({ ...command, reloadRuntimeId }, 8096)).toThrow('reload target');
    }
    expect(() =>
      parseQaHostCommand({ ...command, phase: 'verify-reload', reloadRuntimeId: originalRuntimeId }, 8096),
    ).toThrow('reload target');
    expect(parseQaHostCommand(command, 8096)).not.toHaveProperty('reloadRuntimeId');
  });

  it('keeps polling through idle and invalid commands, then delivers repeated and changed phases', async () => {
    vi.useFakeTimers();
    const payloads: unknown[] = [
      null,
      { ...command, runId: '../boardsesh' },
      { ...command, receiptPort: 8097 },
      command,
      command,
      { ...command, phase: 'verify-reload' },
    ];
    const transport = vi.fn(async () => ({ ok: true, json: async () => payloads.shift() }));
    vi.stubGlobal('fetch', transport);
    const receive = vi.fn();
    const stop = startQaCommandPolling(8096, receive);
    await vi.advanceTimersByTimeAsync(2500);
    expect(receive.mock.calls.map(([request]) => request.phase)).toEqual([
      'prepare-reload',
      'prepare-reload',
      'verify-reload',
    ]);
    expect(transport.mock.calls).toHaveLength(6);
    expect(transport).toHaveBeenCalledWith(
      'http://127.0.0.1:8096/command',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    stop();
  });

  it('aborts a stalled request and retries within a bounded interval', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transport = vi.fn(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signals.push(options.signal);
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', transport);
    const receive = vi.fn();
    const stop = startQaCommandPolling(8096, receive);
    await vi.advanceTimersByTimeAsync(3500);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(receive).not.toHaveBeenCalled();
    stop();
    expect(signals[1].aborted).toBe(true);
  });

  it('does not deliver an in-flight command or poll again after unmount', async () => {
    vi.useFakeTimers();
    let resolveBody: (body: unknown) => void = () => {};
    const body = new Promise((resolve) => {
      resolveBody = resolve;
    });
    const transport = vi.fn(async () => ({ ok: true, json: () => body }));
    vi.stubGlobal('fetch', transport);
    const receive = vi.fn();
    const stop = startQaCommandPolling(8096, receive);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    resolveBody(command);
    await vi.advanceTimersByTimeAsync(1000);
    expect(receive).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid port before any network request', () => {
    const transport = vi.fn();
    vi.stubGlobal('fetch', transport);
    for (const port of [0, 1023, 65536, NaN])
      expect(() => startQaCommandPolling(port, vi.fn())).toThrow('control port');
    expect(transport).not.toHaveBeenCalled();
  });
});
