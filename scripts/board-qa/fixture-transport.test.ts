import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Evidence } from './evidence';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
import { SerialTransport } from './fixture';

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn(),
  });
  processMock.spawn.mockReturnValue(child);
  const directory = mkdtempSync(join(tmpdir(), 'fixture-transport-'));
  directories.push(directory);
  return { child, transport: new SerialTransport('fake-port', new Evidence(directory)) };
}
it('handles EPIPE and rejects writes after process exit', async () => {
  const { child, transport } = harness();
  const failed = vi.fn();
  const opening = transport.open(vi.fn(), failed);
  child.stdout.write('{"transportReady":true}\n');
  await opening;
  expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
  expect(failed.mock.calls[0][0]).toMatchObject({ kind: 'infrastructure', message: 'USB transport input pipe failed' });
  child.exitCode = 1;
  expect(() => transport.write({ action: 'status', requestId: 'probe' })).toThrow('not writable');
  await transport.close();
});
it('reports a typed receiver failure without waiting for process exit', async () => {
  const { child, transport } = harness();
  const failed = vi.fn();
  const opening = transport.open(vi.fn(), failed);
  child.stdout.write('{"transportReady":true}\n');
  await opening;
  child.stdout.write('{"transportError":"invalid UTF-8 reply"}\n');
  expect(failed.mock.calls[0][0]).toMatchObject({
    kind: 'infrastructure',
    message: 'USB transport failure: invalid UTF-8 reply',
  });
  child.exitCode = 1;
  await transport.close();
});
it('waits for process close and escalates a stuck owner', async () => {
  vi.useFakeTimers();
  const { child, transport } = harness();
  const opening = transport.open(vi.fn(), vi.fn());
  child.stdout.write('{"transportReady":true}\n');
  await opening;
  let closed = false;
  const closing = transport.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(() => child.stdin.emit('error', new Error('EPIPE during cleanup'))).not.toThrow();
  await vi.advanceTimersByTimeAsync(2000);
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(closed).toBe(false);
  child.emit('close');
  await closing;
  expect(closed).toBe(true);
});
