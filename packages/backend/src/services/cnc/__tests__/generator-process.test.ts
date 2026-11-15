import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { runCncGenerator } from '../generator-process';

const BUILD_SHA = 'a'.repeat(40);
function processFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}
let child = processFixture();
function reply(overrides: Record<string, unknown> = {}) {
  const request = JSON.parse(String(child.stdin.read())) as { requestId: string };
  child.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      buildSha: BUILD_SHA,
      generatorVersion: '1.0.0',
      result: { panels: [] },
      ...overrides,
    }),
  );
  child.emit('close', 0);
}
beforeEach(() => {
  child = processFixture();
  spawnMock.mockReset().mockReturnValue(child);
  vi.stubEnv('CNC_GENERATOR_SHA', BUILD_SHA);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CNC generator process isolation', () => {
  it('uses fixed shell-free arguments, stdin input, and a credential allowlist', async () => {
    for (const key of ['DATABASE_URL', 'SMTP_PASSWORD', 'NEXTAUTH_SECRET', 'CNC_WORKER_SECRET'])
      vi.stubEnv(key, 'excluded-secret');
    vi.stubEnv('FINGERPRINT_SECRET', 'durable-mark');
    vi.stubEnv('PRIVATE_AWS_SECRET_ACCESS_KEY', 'private-storage-key');
    vi.stubEnv('CNC_GENERATOR_PYTHON', '/venv/python');
    const result = runCncGenerator('version', {}, {}, new AbortController().signal);
    const [executable, argumentsList, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { shell: boolean; env: Record<string, string> },
    ];
    expect(executable).toBe('/venv/python');
    expect(argumentsList).toEqual(['-m', 'cncpack.worker.task']);
    expect(options.shell).toBe(false);
    expect(options.env).toMatchObject({
      FINGERPRINT_SECRET: 'durable-mark',
      PRIVATE_AWS_SECRET_ACCESS_KEY: 'private-storage-key',
    });
    for (const key of ['DATABASE_URL', 'SMTP_PASSWORD', 'NEXTAUTH_SECRET', 'CNC_WORKER_SECRET'])
      expect(options.env).not.toHaveProperty(key);
    reply({ result: { name: 'cncpack', protocolVersion: 1 } });
    await expect(result).resolves.toEqual({
      buildSha: BUILD_SHA,
      generatorVersion: '1.0.0',
      result: { name: 'cncpack', protocolVersion: 1 },
    });
  });

  it('drains private stderr without surfacing it in errors or application logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = runCncGenerator('full', {}, {}, new AbortController().signal);
    child.stderr.write('fingerprint-secret=do-not-leak');
    child.emit('close', 1);
    await expect(result).rejects.toMatchObject({ message: 'GENERATOR_FAILED', retryable: true });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    { buildSha: 'b'.repeat(40) },
    { requestId: '00000000-0000-4000-8000-000000000000' },
    { protocolVersion: 2 },
  ])('rejects a release or request identity mismatch: %j', async (overrides) => {
    const result = runCncGenerator('layout', {}, {}, new AbortController().signal);
    reply(overrides);
    await expect(result).rejects.toMatchObject({ code: 'GENERATOR_RELEASE_MISMATCH', retryable: false });
  });

  it('preserves classified permanent validation failures', async () => {
    const result = runCncGenerator('artwork', {}, {}, new AbortController().signal);
    reply({
      ok: false,
      result: undefined,
      error: { code: 'ARTWORK_COLLISION', retryable: false, message: 'private source text' },
    });
    await expect(result).rejects.toMatchObject({ message: 'ARTWORK_COLLISION', retryable: false });
  });

  it('bounds renderer output and terminates the process', async () => {
    const result = runCncGenerator('full', {}, {}, new AbortController().signal);
    child.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null);
    await expect(result).rejects.toMatchObject({ code: 'RESULT_TOO_LARGE', retryable: false });
  });

  it('rejects oversized input before creating a process', async () => {
    await expect(
      runCncGenerator('artwork', {}, { asset: 'x'.repeat(32 * 1024 * 1024) }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE', retryable: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not spawn for an already cancelled job', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(runCncGenerator('layout', {}, {}, controller.signal)).rejects.toThrow('cancelled');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('escalates cancellation after five seconds and clears the timer on close', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = runCncGenerator('full', {}, {}, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'GENERATOR_ABORTED', retryable: true });
    controller.abort();
    expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    child.emit('close', null);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies broken JSON and process startup failures without raw errors', async () => {
    const malformed = runCncGenerator('layout', {}, {}, new AbortController().signal);
    child.stdout.write('private invalid response');
    child.emit('close', 0);
    await expect(malformed).rejects.toMatchObject({ code: 'INVALID_GENERATOR_RESULT', retryable: true });
    child = processFixture();
    spawnMock.mockReturnValue(child);
    const failed = runCncGenerator('layout', {}, {}, new AbortController().signal);
    child.emit('error', new Error('sensitive executable detail'));
    child.emit('close', -1);
    await expect(failed).rejects.toMatchObject({ message: 'GENERATOR_START_FAILED', retryable: true });
  });
});
