/// <reference types="node" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commands = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: commands,
}));
vi.mock('../lib/ios-simulator-lease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ios-simulator-lease')>();
  return { ...actual, resolveSimulatorUdid: vi.fn(actual.resolveSimulatorUdid), guardSimulatorCommand: vi.fn() };
});

import { resolveSimulatorUdid } from '../lib/ios-simulator-lease';
import { runSimulatorSmoke } from '../mobile-simulator-smoke';

const directories: string[] = [];
const simulatorUdid = '561A4D7D-12C6-4B27-A956-A69C4436F4BE';

function fixture(options: {
  nativeVersion?: string;
  installedVersion?: string;
  unreadableMetadata?: boolean;
  release?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'boardsesh-cached-smoke-test-'));
  directories.push(root);
  const appPath = join(root, 'Boardsesh.app');
  const mobile = join(root, 'packages/mobile');
  mkdirSync(appPath, { recursive: true });
  mkdirSync(mobile, { recursive: true });
  writeFileSync(
    join(appPath, 'Info.plist'),
    JSON.stringify({ CFBundleIdentifier: 'test.boardsesh', CFBundleExecutable: 'Boardsesh' }),
  );
  writeFileSync(join(appPath, 'Boardsesh'), 'fixture executable');
  // A deliberately different declaration proves resolution uses the installed package.
  writeFileSync(join(mobile, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '999.0.0' } }));
  if (options.installedVersion !== undefined) {
    const installed = join(mobile, 'node_modules/react-native');
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ name: 'react-native', version: options.installedVersion }),
    );
  }
  if (options.nativeVersion !== undefined || options.unreadableMetadata) {
    const resources = join(appPath, 'React-Core_privacy.bundle');
    mkdirSync(resources);
    writeFileSync(
      join(resources, 'Info.plist'),
      options.unreadableMetadata
        ? 'unreadable plist'
        : JSON.stringify({ CFBundleShortVersionString: options.nativeVersion }),
    );
  }
  if (options.release) writeFileSync(join(appPath, 'main.jsbundle'), 'fixture embedded JS');
  commands.mockImplementation((binary: string, args: readonly string[]) => {
    if (binary === 'plutil') {
      // Plist extraction is mocked at the command boundary; fixtures stay portable.
      const plist: unknown = JSON.parse(readFileSync(args.at(-1)!, 'utf8'));
      const extracted = (plist as Record<string, unknown>)[args[1]];
      if (typeof extracted !== 'string') throw new Error('No string plist field');
      return extracted;
    }
    if (binary === 'xcrun' && args[0] === 'dwarfdump')
      return 'UUID: 00000000-0000-0000-0000-000000000001 (arm64) fixture';
    if (binary === 'xcrun' && args[0] === 'simctl') {
      if (args[1] === 'list')
        return JSON.stringify({ devices: { runtime: [{ udid: simulatorUdid, name: 'Fixture', state: 'Booted' }] } });
      if (args[1] === 'get_app_container') return appPath;
      return '';
    }
    throw new Error(`Unexpected command: ${binary}`);
  });
  return { root, appPath };
}

function expectNoSimulatorCommands(): void {
  expect(resolveSimulatorUdid).not.toHaveBeenCalled();
  expect(commands.mock.calls.filter(([binary, args]) => binary === 'xcrun' && args[0] === 'simctl')).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv('BOARDSESH_IOS_SIMULATOR_UDID', simulatorUdid);
  vi.clearAllMocks();
  commands.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('cached Debug simulator RN preflight', () => {
  it('rejects mismatched native RN before simulator selection or commands', () => {
    const { root, appPath } = fixture({ nativeVersion: '0.88.0', installedVersion: '0.86.3' });
    expect(() => runSimulatorSmoke(appPath, root)).toThrow(
      /uses React Native 0\.88\.0.*installs 0\.86\.3.*matching Debug app/,
    );
    expectNoSimulatorCommands();
  });

  it.each(['0.86.3', '0.88.0'])('allows exact installed RN %s from the invoking workspace', (version) => {
    const { root, appPath } = fixture({ nativeVersion: version, installedVersion: version });
    runSimulatorSmoke(appPath, root);
    expect(resolveSimulatorUdid).toHaveBeenCalledOnce();
    expect(commands).toHaveBeenCalledWith('xcrun', ['simctl', 'install', simulatorUdid, appPath], expect.anything());
    expect(commands).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'launch', simulatorUdid, 'test.boardsesh'],
      expect.anything(),
    );
  });

  it('rejects legacy Debug exports with missing RN metadata before simulator commands', () => {
    const { root, appPath } = fixture({ installedVersion: '0.86.3' });
    expect(() => runSimulatorSmoke(appPath, root)).toThrow(/Cannot verify cached Debug.*readable React-Core metadata/);
    expectNoSimulatorCommands();
  });

  it('rejects unreadable RN metadata before simulator commands', () => {
    const { root, appPath } = fixture({ installedVersion: '0.86.3', unreadableMetadata: true });
    expect(() => runSimulatorSmoke(appPath, root)).toThrow(/Cannot verify cached Debug.*readable React-Core metadata/);
    expectNoSimulatorCommands();
  });

  it('rejects blank RN metadata before simulator commands', () => {
    const { root, appPath } = fixture({ installedVersion: '0.86.3', nativeVersion: '' });
    expect(() => runSimulatorSmoke(appPath, root)).toThrow(/Cannot verify cached Debug/);
    expectNoSimulatorCommands();
  });

  it('rejects missing checkout-local installed RN before simulator commands', () => {
    const { root, appPath } = fixture({ nativeVersion: '0.86.3' });
    expect(() => runSimulatorSmoke(appPath, root)).toThrow(
      /Cannot read the installed React Native version.*this checkout/,
    );
    expectNoSimulatorCommands();
  });

  it.each([{ nativeVersion: '0.88.0' }, {}])('keeps self-contained Release behavior with metadata %j', (metadata) => {
    const { root, appPath } = fixture({ ...metadata, release: true });
    runSimulatorSmoke(appPath, root);
    expect(
      commands.mock.calls.some(
        ([binary, args]) => binary === 'plutil' && String(args.at(-1)).includes('React-Core_privacy'),
      ),
    ).toBe(false);
    expect(commands).toHaveBeenCalledWith(
      'xcrun',
      ['simctl', 'launch', simulatorUdid, 'test.boardsesh'],
      expect.anything(),
    );
  });
});
