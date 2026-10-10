/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
}
interface Job {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: { push?: { paths: string[] }; workflow_dispatch?: { inputs?: unknown } | null };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}
const readWorkflow = (path: string): Workflow => parse(readFileSync(path, 'utf8')) as Workflow;

describe('published Android dev-client gate', () => {
  const workflow = readWorkflow('.github/workflows/android-apk-dev-client.yml');

  it('gates the whole build job on automatic and manual runs without a force input', () => {
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.workflow_dispatch?.inputs).toBeUndefined();
    expect(workflow.jobs['build-and-release'].needs).toBe('gate');
    expect(workflow.jobs['build-and-release'].if).toBe("needs.gate.outputs.should_build == 'true'");
    expect(workflow.jobs.gate.steps.find((step) => step.id === 'native_gate')?.with).toEqual({
      platform: 'android',
      'comparison-mode': 'published-dev-client',
    });
    expect(workflow.jobs.gate.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(workflow.jobs.gate.if).toBeUndefined();
  });

  it('covers root native dependency and gate changes in automatic triggers', () => {
    expect(workflow.on.push?.paths).toEqual(
      expect.arrayContaining([
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'patches/**',
        '.github/actions/mobile-native-gate/**',
        'scripts/mobile-android-dev-gate.ts',
        'scripts/lib/android-dev-native.ts',
        'scripts/lib/mobile-runtime-version.ts',
      ]),
    );
  });

  it('preserves the universal debug APK and stable download asset', () => {
    const steps = workflow.jobs['build-and-release'].steps;
    expect(steps.find((step) => step.run?.includes('assembleDebug'))?.run).toContain(
      '-PreactNativeArchitectures=arm64-v8a,x86_64 -PboardseshAbiFilters=arm64-v8a,x86_64',
    );
    expect(steps.find((step) => step.uses?.startsWith('softprops/action-gh-release'))?.with?.files).toContain(
      'boardsesh-dev-android.apk',
    );
  });

  it('keeps the PR gate default separate from the published-APK comparison', () => {
    const action = parse(readFileSync('.github/actions/mobile-native-gate/action.yml', 'utf8')) as {
      inputs: Record<string, { default?: string }>;
      runs: { steps: Step[] };
    };
    expect(action.inputs['comparison-mode'].default).toBe('base-branch');
    const dev = action.runs.steps.find((step) => step.id === 'dev_decide');
    expect(dev?.if).toBe("inputs.comparison-mode == 'published-dev-client'");
    expect(dev?.run).toContain('set -euo pipefail');
    expect(dev?.run).toContain('vp install --frozen-lockfile');
    expect(dev?.run).toContain('vp exec tsx scripts/mobile-android-dev-gate.ts');
    expect(dev?.run).not.toContain('workflow_dispatch');
    expect(action.runs.steps.find((step) => step.id === 'decide')?.if).toBe(
      "inputs.comparison-mode != 'published-dev-client'",
    );
  });

  it('lets screenshot and smoke consumers verify successful dev APK provenance', () => {
    const screenshots = readWorkflow('.github/workflows/mobile-screenshots-android.yml');
    expect(screenshots.permissions?.actions).toBe('read');
    const smoke = readWorkflow('.github/workflows/mobile-e2e-gate.yml');
    expect(smoke.jobs['android-smoke'].permissions?.actions).toBe('read');
  });
});
