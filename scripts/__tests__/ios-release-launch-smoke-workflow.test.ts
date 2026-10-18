import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(smoke['timeout-minutes']).toBe(15);
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
    expect(simulator.run).toContain("print(device['udid'])");
    expect(simulator.run).toContain('echo "udid=$SIMULATOR_UDID" >> "$GITHUB_OUTPUT"');
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
