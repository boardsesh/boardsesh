/// <reference types="node" />
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn, execFileSync: vi.fn() }));
import { runBoundedTool, usefulAllocationsExport, verifyFailedAllocationProbe } from '../lib/ios-memory-tools';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  spawn.mockReset();
});

describe('bounded owned memory inspection', () => {
  it('requires allocation data rows, rather than treating a trace directory as success', () => {
    const toc = '<trace-toc><run><data><table schema="allocations-all-allocations" /></data></run></trace-toc>';
    expect(usefulAllocationsExport(toc, '<table><row><size>32</size></row></table>')).toBe(true);
    expect(usefulAllocationsExport(toc, '<table/>')).toBe(false);
    expect(usefulAllocationsExport('<table schema="time-profile"/>', '<row/>')).toBe(false);
    expect(usefulAllocationsExport(toc, '<error>failed</error><row>bad</row>')).toBe(false);
  });
  it('settles at deadline even when recorder never closes its inherited pipes', async () => {
    vi.useFakeTimers();
    const recorder = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    });
    spawn.mockReturnValue(recorder);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const capture = runBoundedTool('xcrun', ['xctrace', 'record'], 30000);
    await vi.advanceTimersByTimeAsync(29000);
    expect(signal).toHaveBeenCalledWith(-456, 'SIGINT');
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal).toHaveBeenCalledWith(-456, 'SIGKILL');
    await expect(capture).resolves.toMatchObject({ timedOut: true, status: null, recorderPid: 456, durationMs: 30000 });
    expect(recorder.stdout.destroyed).toBe(true);
    await expect(capture).resolves.toMatchObject({ cleanupConfirmed: false });
  });
  it('does not claim cleanup after a rejected owned signal', async () => {
    vi.useFakeTimers();
    const recorder = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    });
    spawn.mockReturnValue(recorder);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    const capture = runBoundedTool('xcrun', ['xctrace', 'record']);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(capture).resolves.toMatchObject({ cleanupConfirmed: false, timedOut: true });
  });

  it('does not signal a recorder that has exited before the deadline', async () => {
    vi.useFakeTimers();
    const recorder = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: 0,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    });
    spawn.mockReturnValue(recorder);
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const capture = runBoundedTool('heap', ['123']);
    recorder.stdout.emit('data', Buffer.from('object count 4'));
    recorder.emit('close', 0);
    await vi.advanceTimersByTimeAsync(30000);
    await expect(capture).resolves.toMatchObject({ status: 0, timedOut: false, stdout: 'object count 4' });
    expect(signal).not.toHaveBeenCalled();
  });
  it('bounds retained output and rejects unbounded deadlines', async () => {
    const recorder = Object.assign(new EventEmitter(), {
      pid: 456,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn(),
    });
    spawn.mockReturnValue(recorder);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const capture = runBoundedTool('heap', ['123']);
    recorder.stdout.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
    await expect(capture).resolves.toMatchObject({ overflow: true, status: null, stdout: '' });
    await expect(runBoundedTool('heap', ['123'], 31000)).rejects.toThrow(/deadline/);
  });
});

describe('explicit graph fallback provenance', () => {
  const udid = '00000000-0000-0000-0000-000000000001';
  const failedProbe = {
    command: 'xcrun',
    args: [
      'xctrace',
      'record',
      '--device',
      udid,
      '--template',
      'Allocations',
      '--time-limit',
      '10s',
      '--attach',
      '123',
      '--output',
      '/retained/invalid.trace',
    ],
    recorderPid: 456,
    status: null,
    timedOut: true,
    durationMs: 30006,
  };
  it('requires the failed owned simulator attachment and records newly verified group absence', () => {
    const groupAbsent = vi.fn(() => true);
    expect(verifyFailedAllocationProbe(failedProbe, udid, groupAbsent)).toMatchObject({
      recorderPid: 456,
      recorderGroupAbsent: true,
      allocationValid: false,
    });
    expect(groupAbsent).toHaveBeenCalledWith(456);
  });
  it('rejects host-only, successful, unbounded, unattached or foreign probes', () => {
    for (const invalid of [
      null,
      { ...failedProbe, status: 0, timedOut: false },
      { ...failedProbe, durationMs: 60000 },
      {
        ...failedProbe,
        args: failedProbe.args.filter((argument) => argument !== '--output' && argument !== '/retained/invalid.trace'),
      },
      { ...failedProbe, args: failedProbe.args.filter((argument) => argument !== '--device' && argument !== udid) },
      { ...failedProbe, args: failedProbe.args.map((argument) => (argument === '123' ? 'not-a-pid' : argument)) },
      { ...failedProbe, args: failedProbe.args.map((argument) => (argument === udid ? 'foreign-device' : argument)) },
    ])
      expect(() => verifyFailedAllocationProbe(invalid, udid, () => true)).toThrow(/recorded failed/);
  });
  it('refuses a live or inaccessible recorder group', () => {
    expect(() => verifyFailedAllocationProbe(failedProbe, udid, () => false)).toThrow(/absence/);
    const existenceProbe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no permission'), { code: 'EPERM' });
    });
    expect(() => verifyFailedAllocationProbe(failedProbe, udid)).toThrow(/absence/);
    expect(existenceProbe).toHaveBeenCalledWith(456, 0);
  });
  it('uses read-only ESRCH as absence proof without sending shutdown signals', () => {
    const existenceProbe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    expect(verifyFailedAllocationProbe(failedProbe, udid).recorderGroupAbsent).toBe(true);
    expect(existenceProbe).toHaveBeenCalledTimes(2);
    expect(existenceProbe).toHaveBeenNthCalledWith(1, 456, 0);
    expect(existenceProbe).toHaveBeenNthCalledWith(2, -456, 0);
  });
});
