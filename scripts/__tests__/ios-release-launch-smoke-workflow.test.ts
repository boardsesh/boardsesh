import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  'timeout-minutes'?: number;
  with?: Record<string, string | number>;
}

interface IosWorkflow {
  on: { pull_request: { paths: string[] } };
  env: Record<string, string>;
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

const repoRoot = resolve(import.meta.dirname, '../..');
const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/ios-rn-ci.yml'), 'utf8')) as IosWorkflow;
const nativeAction = parse(readFileSync(join(repoRoot, '.github/actions/mobile-native-gate/action.yml'), 'utf8')) as {
  runs: { steps: WorkflowStep[] };
};
const steps = workflow.jobs['build-and-test'].steps;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function requiredStep(name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  expect(step, `missing workflow step: ${name}`).toBeDefined();
  return step!;
}

describe('iOS Release launch workflow', () => {
  it('launches the existing Release output immediately after its ABI check, before Swift tests', () => {
    const abiIndex = steps.findIndex((step) => step.name === 'Check embedded framework ABI');
    const smoke = requiredStep('Launch the Release app and watch for crashes');
    expect(steps.indexOf(smoke)).toBe(abiIndex + 1);
    expect(smoke.run).toContain('vp exec tsx scripts/ios-release-launch-smoke.ts');
    expect(smoke.run).toContain('--app packages/mobile/ios/build/Build/Products/Release-iphonesimulator/Boardsesh.app');
    expect(smoke.run).toContain("--device '${{ steps.simulator.outputs.udid }}'");
    expect(smoke.run).toContain("--evidence-dir '${{ runner.temp }}/ios-release-launch-smoke'");
    expect(smoke['timeout-minutes']).toBe(20);
    expect(smoke.if).toBeUndefined();
    expect(steps.indexOf(smoke)).toBeLessThan(steps.indexOf(requiredStep('Add RN Swift test target')));
  });

  it('builds a runnable Release binary with simulator entitlement packaging enabled', () => {
    const build = requiredStep('Build the Release app (compiles startup + Pods + patched native modules)');
    expect(build.run).toContain('-configuration Release');
    expect(build.run).toContain('CODE_SIGN_IDENTITY=-');
    expect(build.run).toContain('CODE_SIGNING_ALLOWED=YES');
    expect(build.run).toContain('CODE_SIGN_ENTITLEMENTS="$PWD/scripts/screenshot-sim.entitlements"');
    expect(build.run).not.toMatch(/CODE_SIGNING_(?:ALLOWED|REQUIRED)=NO/);
    expect(workflow.env.EXPO_PUBLIC_SENTRY_DSN).toBe('http://ci-compiler@127.0.0.1:1/1');
  });

  it('resolves an exact simulator before launching and reuses it for the standalone Swift tests', () => {
    const simulator = requiredStep('Resolve simulator destination');
    const smoke = requiredStep('Launch the Release app and watch for crashes');
    expect(steps.indexOf(simulator)).toBeLessThan(steps.indexOf(smoke));
    expect(simulator.run).toContain("simctl('create', name, device_type, runtime)");
    expect(simulator.run).toContain('output.write(f"udid={simulator_udid}\\n")');
    expect(simulator.run).toContain('capture_output=True, text=True, timeout=30');
    for (const name of ['Build for testing', 'Run Swift unit tests']) {
      expect(requiredStep(name).run).toContain(
        "-destination 'platform=iOS Simulator,id=${{ steps.simulator.outputs.udid }}'",
      );
    }
  });

  it('uploads launch diagnostics even when the smoke fails', () => {
    const artifact = requiredStep('Preserve Release launch evidence');
    expect(artifact.if).toBe('always()');
    expect(artifact.uses).toBe('actions/upload-artifact@v4');
    expect(artifact.with?.path).toBe('${{ runner.temp }}/ios-release-launch-smoke');
    expect(steps.indexOf(artifact)).toBeGreaterThan(
      steps.indexOf(requiredStep('Launch the Release app and watch for crashes')),
    );
  });

  it('triggers for the checker, tests, reused helpers, and simulator entitlements', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'scripts/ios-release-launch-smoke.ts',
        'scripts/__tests__/ios-release-launch-smoke*.test.ts',
        'scripts/lib/ios-capture-diagnostics.ts',
        'scripts/lib/ios-simulator-lease.ts',
        'scripts/screenshot-sim.entitlements',
      ]),
    );
    const checkerTests = requiredStep('Check the Release launch guard');
    expect(checkerTests.run).toContain('scripts/__tests__/ios-release-launch-smoke.test.ts');
    expect(checkerTests.run).toContain('scripts/__tests__/ios-release-launch-smoke-workflow.test.ts');
    expect(steps.indexOf(checkerTests)).toBeLessThan(
      steps.indexOf(requiredStep('Build the Release app (compiles startup + Pods + patched native modules)')),
    );
  });
});

const newSimulatorUdid = '67EF58B2-C7AA-44DB-9ABF-908729CC3F05';
const templateSimulatorUdid = 'D0D80A96-1387-4502-BEFD-3CB0955AD02A';
const selectedRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-1';
const selectedDeviceType = 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo';

function simulatorInventory() {
  return {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
        {
          name: 'iPhone 17',
          udid: '7F507CBA-0024-45B7-A914-E930C319DAD8',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        },
      ],
      [selectedRuntime]: [
        { name: 'iPad', udid: '225E0758-7000-4DB5-BDB8-9A5DB2ED81B3', isAvailable: true },
        {
          name: 'iPhone Duo',
          udid: templateSimulatorUdid,
          isAvailable: true,
          deviceTypeIdentifier: selectedDeviceType,
        },
        {
          name: 'iPhone 17',
          udid: 'EE64549B-A61D-4A36-B40F-EA63ECCCE04E',
          isAvailable: true,
          deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
        },
      ],
    },
    runtimes: [
      { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', isAvailable: true },
      { identifier: selectedRuntime, isAvailable: true },
    ],
    devicetypes: [
      { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
      { identifier: selectedDeviceType },
    ],
  };
}

function runSimulatorSelector(
  options: {
    inventory?: ReturnType<typeof simulatorInventory>;
    createdUdid?: string;
    createStatus?: number;
    listStatus?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'ios-release-simulator-'));
  temporaryDirectories.push(directory);
  const xcrunPath = join(directory, 'xcrun');
  const callsPath = join(directory, 'calls.jsonl');
  const outputPath = join(directory, 'output');
  writeFileSync(
    xcrunPath,
    `#!/usr/bin/env python3
import json, os, sys
arguments = sys.argv[1:]
with open(os.environ['CI_SIM_CALLS'], 'a') as calls:
    calls.write(json.dumps(arguments) + '\\n')
if arguments == ['simctl', 'list', '--json']:
    print(os.environ['CI_SIM_INVENTORY'])
    sys.exit(int(os.environ['CI_SIM_LIST_STATUS']))
if len(arguments) == 5 and arguments[:2] == ['simctl', 'create']:
    print(os.environ['CI_SIM_CREATED_UDID'])
    print('fixture creation diagnostic', file=sys.stderr)
    sys.exit(int(os.environ['CI_SIM_CREATE_STATUS']))
print('Unexpected simulator command', file=sys.stderr)
sys.exit(1)
`,
  );
  chmodSync(xcrunPath, 0o755);
  const script = requiredStep('Resolve simulator destination').run!;
  const result = spawnSync('bash', ['-c', script], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GITHUB_OUTPUT: outputPath,
      GITHUB_RUN_ID: '7171',
      GITHUB_RUN_ATTEMPT: '3',
      CI_SIM_CALLS: callsPath,
      CI_SIM_INVENTORY: JSON.stringify(options.inventory ?? simulatorInventory()),
      CI_SIM_CREATED_UDID: options.createdUdid ?? newSimulatorUdid,
      CI_SIM_CREATE_STATUS: String(options.createStatus ?? 0),
      CI_SIM_LIST_STATUS: String(options.listStatus ?? 0),
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[])
    : [];
  return { result, calls, output: existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '' };
}

describe('CI-owned simulator allocation', () => {
  it('creates a fresh device with the first available iPhone model on the newest runtime', () => {
    const { result, calls, output } = runSimulatorSelector();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls).toEqual([
      ['simctl', 'list', '--json'],
      [
        'simctl',
        'create',
        expect.stringMatching(/^Boardsesh CI 7171-3-[a-f0-9]{8}$/),
        selectedDeviceType,
        selectedRuntime,
      ],
    ]);
    expect(output).toBe(`udid=${newSimulatorUdid}\n`);
    expect(output).not.toContain(templateSimulatorUdid);
    expect(result.stdout).toContain(`iPhone Duo on ${selectedRuntime}`);
    expect(
      calls.every((arguments_) => !arguments_.some((argument) => ['erase', 'delete', 'reset'].includes(argument))),
    ).toBe(true);
  });

  it('fails before allocating when listing simulators fails', () => {
    const { result, calls, output } = runSimulatorSelector({ listStatus: 9 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Simulator list --json failed (9)');
    expect(calls).toHaveLength(1);
    expect(output).toBe('');
  });

  it('fails clearly on creation failure without publishing a simulator destination', () => {
    const { result, calls, output } = runSimulatorSelector({ createStatus: 7 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed (7): fixture creation diagnostic');
    expect(calls).toHaveLength(2);
    expect(output).toBe('');
  });

  it.each(['runtime', 'device type'] as const)(
    'rejects missing compatible %s metadata without switching model',
    (missing) => {
      const inventory = simulatorInventory();
      if (missing === 'runtime') inventory.runtimes = [];
      else inventory.devicetypes = inventory.devicetypes.filter(({ identifier }) => identifier !== selectedDeviceType);
      const { result, calls, output } = runSimulatorSelector({ inventory });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Selected iPhone iPhone Duo has no compatible runtime/device metadata');
      expect(calls).toHaveLength(1);
      expect(output).toBe('');
    },
  );

  it('rejects an inventory without an available iPhone', () => {
    const inventory = simulatorInventory();
    for (const devices of Object.values(inventory.devices)) {
      for (const device of devices) device.isAvailable = false;
    }
    const { result, calls, output } = runSimulatorSelector({ inventory });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no available iPhone');
    expect(calls).toHaveLength(1);
    expect(output).toBe('');
  });

  it.each(['not-a-uuid', '', `${newSimulatorUdid}\nextra output`])(
    'rejects malformed created UUID %j',
    (createdUdid) => {
      const { result, output } = runSimulatorSelector({ createdUdid });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Simulator create returned a malformed UUID');
      expect(output).toBe('');
    },
  );

  it('rejects an existing UUID even when creation returns it with different casing', () => {
    const { result, output } = runSimulatorSelector({ createdUdid: templateSimulatorUdid.toLowerCase() });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Simulator create returned an existing UUID');
    expect(output).toBe('');
  });
});

function nativeGateDecision(changedPath: string, platform = 'ios'): string {
  const directory = mkdtempSync(join(tmpdir(), 'ios-release-gate-'));
  temporaryDirectories.push(directory);
  const gitPath = join(directory, 'git');
  // Only git discovery is stubbed: execute the actual action's decision script,
  // including its pathspecs and platform condition, without network or installs.
  writeFileSync(
    gitPath,
    `#!/bin/bash
case "$1" in
  fetch) exit 0 ;;
  rev-parse) echo fixture-base ;;
  diff)
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done
    shift
    for pathspec in "$@"; do
      case "$CI_GATE_CHANGED_FILE" in
        $pathspec|"$pathspec"/*) echo "$CI_GATE_CHANGED_FILE"; exit 0 ;;
      esac
    done
    ;;
  *) echo "Unexpected git invocation: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(gitPath, 0o755);
  const decisionScript = nativeAction.runs.steps.find((step) => step.id === 'decide')?.run;
  expect(decisionScript).toBeDefined();
  const outputPath = join(directory, 'output');
  const result = spawnSync('bash', ['-c', decisionScript!], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CI_GATE_CHANGED_FILE: changedPath,
      GITHUB_OUTPUT: outputPath,
      EVENT: 'pull_request',
      PLATFORM: platform,
      BASE_REF: 'main',
    },
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return readFileSync(outputPath, 'utf8').trim();
}

describe('native gate exercises iOS launch tooling changes', () => {
  it.each([
    '.github/workflows/ios-rn-ci.yml',
    'scripts/ios-release-launch-smoke.ts',
    'scripts/__tests__/ios-release-launch-smoke.test.ts',
    'scripts/__tests__/ios-release-launch-smoke-workflow.test.ts',
    'scripts/lib/ios-capture-diagnostics.ts',
    'scripts/lib/ios-simulator-lease.ts',
    'scripts/screenshot-sim.entitlements',
  ])('forces an iOS build for %s even with unchanged native inputs', (changedPath) => {
    expect(nativeGateDecision(changedPath)).toBe('should_build=true');
  });

  it('preserves skipping ordinary JS changes and Android builds for iOS-only tools', () => {
    expect(nativeGateDecision('packages/mobile/src/example.ts')).toBe('should_build=false');
    expect(nativeGateDecision('scripts/ios-release-launch-smoke.ts', 'android')).toBe('should_build=false');
  });
});
