import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveIosCaptureDiagnostics, snapshotIosDiagnosticReports } from '../lib/ios-capture-diagnostics';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('live CPP simulator diagnostic preservation', () => {
  it('continues past inaccessible directories and reports removed during collection', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpp-ios-diagnostics-'));
    roots.push(root);
    writeFileSync(join(root, 'not-a-directory'), 'file');
    symlinkSync(join(root, 'removed-report'), join(root, 'Boardsesh-rotated.ips'));
    writeFileSync(join(root, 'Boardsesh-current.ips'), 'actual app report');
    expect(snapshotIosDiagnosticReports([join(root, 'not-a-directory'), join(root, 'missing'), root])).toEqual([
      expect.objectContaining({ path: join(root, 'Boardsesh-current.ips') }),
    ]);
  });
  it('keeps this attempt’s real app reports and exact-device process state before shutdown', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpp-ios-diagnostics-'));
    roots.push(root);
    const reports = join(root, 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'Boardsesh-old.ips'), 'earlier attempt');
    mkdirSync(join(reports, 'Boardsesh-directory.ips'));
    const baseline = snapshotIosDiagnosticReports([reports, join(root, 'missing')]);
    writeFileSync(join(reports, 'Boardsesh-current.ips'), 'actual app crash');
    writeFileSync(join(reports, 'OtherApp-current.ips'), 'unrelated crash');
    writeFileSync(join(reports, 'JetsamEvent-app.ips'), '{"process":"Boardsesh"}');
    writeFileSync(join(reports, 'JetsamEvent-unrelated.ips'), '{"process":"OtherApp"}');
    const nativeLog = join(root, 'native.log');
    writeFileSync(nativeLog, 'live simulator process exit');
    const runCommand = vi.fn(() => ({
      status: 0,
      stdout: 'PID Status Label\n42 0 UIKitApplication:com.boardsesh.app.dev\n43 0 unrelated.application',
    }));
    const target = preserveIosCaptureDiagnostics({
      udid: 'actual-simulator-uuid',
      debugDir: join(root, 'debug'),
      nativeLogPath: nativeLog,
      reportDirectories: [reports],
      baseline,
      runCommand,
    });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith([
      'simctl',
      'spawn',
      'actual-simulator-uuid',
      'launchctl',
      'list',
    ]);
    expect(readFileSync(join(target, 'live-device.log'), 'utf8')).toBe('live simulator process exit');
    expect(JSON.parse(readFileSync(join(target, 'process-state.json'), 'utf8'))).toEqual({
      udid: 'actual-simulator-uuid',
      commandStatus: 0,
      processLines: ['42 0 UIKitApplication:com.boardsesh.app.dev'],
    });
    const preserved = readdirSync(target);
    expect(preserved.filter((filename) => filename.endsWith('.ips'))).toHaveLength(2);
    expect(preserved.some((filename) => filename.endsWith('Boardsesh-current.ips'))).toBe(true);
    expect(preserved.some((filename) => filename.endsWith('JetsamEvent-app.ips'))).toBe(true);
    expect(preserved.join()).not.toMatch(/old|unrelated|OtherApp|directory/);
  });

  it('records unavailable process evidence without launching an app or inventing a crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpp-ios-diagnostics-'));
    roots.push(root);
    const runCommand = vi.fn(() => ({ status: 1, stdout: 'No devices are booted.' }));
    const target = preserveIosCaptureDiagnostics({
      udid: 'actual-simulator-uuid',
      debugDir: root,
      nativeLogPath: join(root, 'missing-log'),
      reportDirectories: [],
      baseline: [],
      runCommand,
    });
    expect(readdirSync(target)).toEqual(['process-state.json']);
    expect(JSON.parse(readFileSync(join(target, 'process-state.json'), 'utf8'))).toEqual({
      udid: 'actual-simulator-uuid',
      commandStatus: 1,
      processLines: [],
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });
  it('bounds report copies and preserves successive attempts independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'cpp-ios-diagnostics-'));
    roots.push(root);
    const reports = join(root, 'reports');
    mkdirSync(reports);
    for (let index = 0; index < 7; index++) writeFileSync(join(reports, `Boardsesh-${index}.ips`), 'actual report');
    writeFileSync(join(reports, 'Boardsesh-oversized.ips'), 'x'.repeat(10 * 1024 * 1024 + 1));
    const input = {
      udid: 'actual-simulator-uuid',
      debugDir: join(root, 'debug'),
      nativeLogPath: join(root, 'missing-log'),
      reportDirectories: [reports],
      baseline: [],
      runCommand: () => ({ status: 0, stdout: '42 0 UIKitApplication:com.boardsesh.app.dev' }),
    };
    const first = preserveIosCaptureDiagnostics(input);
    const second = preserveIosCaptureDiagnostics(input);
    expect(second).not.toBe(first);
    for (const target of [first, second]) {
      expect(readdirSync(target).filter((name) => name.endsWith('.ips'))).toHaveLength(5);
      expect(readdirSync(target).join()).not.toContain('oversized');
    }
  });
});
