/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PROFILE_APP_ID, objectRecord, type ProfilePlatform } from './mobile-profile-protocol';

export function androidProcessPid(stdout: string): number {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 1 || !/^\d+$/.test(parts[0]))
    throw new Error('Expected exactly one selected-device profiling clone process');
  const pid = Number(parts[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid selected-device process PID');
  return pid;
}

export function iosProcessPid(candidate: unknown, executable: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(executable)) throw new Error('Invalid cloned executable name');
  const envelope = objectRecord(candidate),
    result = objectRecord(envelope.result);
  if (!Array.isArray(result.runningProcesses)) throw new Error('Selected-device process list missing');
  const matches = result.runningProcesses
    .map(objectRecord)
    .filter(
      (process) =>
        typeof process.executable === 'string' && process.executable.endsWith(`/${executable}.app/${executable}`),
    );
  if (matches.length !== 1) throw new Error('Expected exactly one selected-device profiling clone executable');
  const pid = matches[0].processIdentifier;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new Error('Invalid selected-device process identifier');
  return Number(pid);
}

export function assertDeviceProcessPid(expected: number, observed: number): void {
  if (observed !== expected)
    throw new Error('Control runtime PID differs from the clone on the explicitly selected physical device');
}

function adbExecutable(): string {
  if (process.env.BOARDSESH_ADB_PATH) return process.env.BOARDSESH_ADB_PATH;
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (sdk && existsSync(join(sdk, 'platform-tools/adb'))) return join(sdk, 'platform-tools/adb');
  }
  return 'adb';
}

/** Executed only by capture, never prepare: read-only queries to the explicit physical target. */
export function selectedDeviceProcessPid(
  platform: ProfilePlatform,
  device: string,
  appPath: string,
  evidenceDirectory: string,
): number {
  if (platform === 'android') {
    const stdout = execFileSync(adbExecutable(), ['-s', device, 'shell', 'pidof', PROFILE_APP_ID], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return androidProcessPid(stdout);
  }
  const executable = execFileSync(
    'plutil',
    ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', join(appPath, 'Info.plist')],
    { encoding: 'utf8', timeout: 10_000 },
  ).trim();
  if (executable !== 'BoardseshPerf' || basename(appPath) !== `${executable}.app`)
    throw new Error('Physical iOS clone must have the unique BoardseshPerf executable/application name');
  const jsonPath = join(evidenceDirectory, 'selected-device-processes.json');
  execFileSync('xcrun', ['devicectl', 'device', 'info', 'processes', '--device', device, '--json-output', jsonPath], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return iosProcessPid(JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown, executable);
}
