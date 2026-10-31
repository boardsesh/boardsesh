import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  simulatorArchitecture,
  assertAppSimulatorArchitecture,
  assertSimulatorBuildSource,
  assertSimulatorCacheArchitecture,
} from '../lib/ios-simulator-architecture.mjs';
const scratch: string[] = [];
beforeEach(() => {
  // Explicit undefined uses production defaults; missing-env fixtures must remove
  // the real CI environment rather than inherit this runner's identity.
  vi.stubEnv('RUNNER_ARCH', undefined);
  vi.stubEnv('CI', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
function directory() {
  const path = mkdtempSync(join(tmpdir(), '7154-intel-'));
  scratch.push(path);
  return path;
}
function app() {
  const path = join(directory(), 'Boardsesh.app');
  mkdirSync(path);
  for (const name of ['Info.plist', 'Boardsesh', 'Boardsesh.debug.dylib'])
    writeFileSync(join(path, name), 'fixture-' + name);
  return path;
}

describe('host-native simulator architecture', () => {
  it.each([
    ['arm64', 'ARM64', 'arm64'],
    ['x64', 'X64', 'x86_64'],
  ] as const)('maps Node %s with runner %s to %s', (node, runner, expected) => {
    expect(simulatorArchitecture(node, runner, true)).toBe(expected);
  });
  it('preserves supported local ARM and Intel builds without Actions env', () => {
    expect(simulatorArchitecture('arm64', undefined, false)).toBe('arm64');
    expect(simulatorArchitecture('x64', undefined, false)).toBe('x86_64');
  });
  it.each([
    ['arm64', 'X64'],
    ['x64', 'ARM64'],
    ['x64', undefined],
    ['arm64', 'arm64'],
    ['ppc64', 'X64'],
  ])('rejects unsupported/mismatched CI identity %s/%s', (node, runner) => {
    expect(() => simulatorArchitecture(node!, runner, true)).toThrow();
  });
  it.each([
    ['arm64', 'ARM64', 'arm64', '1'],
    ['x64', 'X64', 'x86_64', '1'],
    ['arm64', 'ARM64', 'arm64', 'true'],
    ['x64', 'X64', 'x86_64', 'true'],
  ])('reads controlled CI defaults for %s/%s to %s with CI=%s', (node, runner, expected, ci) => {
    vi.stubEnv('RUNNER_ARCH', runner);
    vi.stubEnv('CI', ci);
    expect(simulatorArchitecture(node, undefined)).toBe(expected);
    vi.stubEnv('RUNNER_ARCH', undefined);
    expect(() => simulatorArchitecture(node)).toThrow('architecture mismatch');
  });
  it('defaults to the actual Node host while checking its controlled runner identity', () => {
    vi.stubEnv('RUNNER_ARCH', process.arch === 'arm64' ? 'ARM64' : 'X64');
    vi.stubEnv('CI', '1');
    expect(simulatorArchitecture()).toBe(process.arch === 'arm64' ? 'arm64' : 'x86_64');
  });
  it('keeps X64 and ARM cache identities separate', () => {
    expect(() => assertSimulatorCacheArchitecture('macOS-X64-screenshot-sim-app-v1-digest', 'x86_64')).not.toThrow();
    expect(() => assertSimulatorCacheArchitecture('macOS-ARM64-screenshot-sim-app-v1-digest', 'x86_64')).toThrow(
      'cache key',
    );
    expect(() => assertSimulatorCacheArchitecture('unscoped-cache', 'arm64')).toThrow();
  });
  it('requires actual main and Debug slices, and rejects universal or wrong-architecture cached apps', () => {
    const path = app();
    expect(
      assertAppSimulatorArchitecture(path, 'x86_64', true, () => ['x86_64']).executables.map((binary) => binary.file),
    ).toEqual(['Boardsesh', 'Boardsesh.debug.dylib']);
    expect(() =>
      assertAppSimulatorArchitecture(path, 'x86_64', true, (binary) =>
        basename(binary) === 'Boardsesh' ? ['x86_64'] : ['arm64'],
      ),
    ).toThrow('Boardsesh.debug.dylib');
    expect(() => assertAppSimulatorArchitecture(path, 'x86_64', true, () => ['arm64'])).toThrow('Boardsesh');
    expect(() => assertAppSimulatorArchitecture(path, 'arm64', true, () => ['arm64', 'x86_64'])).toThrow(
      'Wrong simulator slices',
    );
    rmSync(join(path, 'Boardsesh.debug.dylib'));
    expect(() => assertAppSimulatorArchitecture(path, 'arm64', true, () => ['arm64'])).toThrow('missing');
    expect(assertAppSimulatorArchitecture(path, 'arm64', false, () => ['arm64']).executables).toHaveLength(1);
  });
  it('rejects empty Debug companions even when the filename is present', () => {
    const path = app();
    writeFileSync(join(path, 'Boardsesh.debug.dylib'), '');
    expect(() => assertAppSimulatorArchitecture(path, 'arm64', true, () => ['arm64'])).toThrow('missing');
  });
  it('refuses historical or partially overlaid source before building; accepts the coherent captured builder', () => {
    const source = directory();
    mkdirSync(join(source, 'scripts/lib'), { recursive: true });
    writeFileSync(join(source, 'scripts/mobile-build-sim-app.ts'), "const args=['ARCHS=arm64'];");
    expect(() => assertSimulatorBuildSource(source)).toThrow('predates');
    copyFileSync(
      'scripts/lib/ios-simulator-architecture.mjs',
      join(source, 'scripts/lib/ios-simulator-architecture.mjs'),
    );
    expect(() => assertSimulatorBuildSource(source)).toThrow('contract');
    copyFileSync('scripts/mobile-build-sim-app.ts', join(source, 'scripts/mobile-build-sim-app.ts'));
    expect(() => assertSimulatorBuildSource(source)).not.toThrow();
    writeFileSync(join(source, 'scripts/lib/ios-simulator-architecture.mjs'), 'old helper');
    expect(() => assertSimulatorBuildSource(source)).toThrow('contract');
  });
  it('selects host architecture before native setup and validates successful build bytes before exporting', () => {
    const builder = readFileSync('scripts/mobile-build-sim-app.ts', 'utf8');
    expect(builder).toContain('`ARCHS=${architecture}`');
    expect(builder).not.toContain("'ARCHS=arm64'");
    expect(builder.indexOf('const architecture = simulatorArchitecture();')).toBeLessThan(
      builder.indexOf('ensureNativeProject(options.clean)'),
    );
    expect(builder).toMatch(/assertAppSimulatorArchitecture\(\s*appPath,\s*targetArchitecture/);
    expect(builder.indexOf('assertAppSimulatorArchitecture(')).toBeLessThan(
      builder.indexOf('const destination = exportBuiltApp'),
    );
  });
});

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = { 'runs-on'?: string; steps: Step[] };
const workflow = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as { jobs: Record<string, Job> };
describe('host-native video producer and recorder handoff', () => {
  it('hashes the shared architecture helper in every main-branch simulator app producer', () => {
    for (const name of [
      'mobile-store-videos-pipeline',
      'mobile-store-videos-measure',
      'mobile-screenshots-ios',
      'mobile-e2e-gate',
    ]) {
      const producers = Object.values(workflow(name).jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.run?.includes('screenshot-sim-app-v1'));
      expect(producers).toHaveLength(1);
      expect(producers[0].run).toContain("'scripts/lib/ios-simulator-architecture.mjs'");
    }
  });
  it('keeps the normal producer and every native video consumer on ARM, retaining Linux jobs', () => {
    const jobs = workflow('mobile-store-videos-pipeline').jobs;
    for (const name of ['app', 'record', 'crew']) expect(jobs[name]['runs-on']).toBe('macos-26');
    for (const name of ['preflight', 'render', 'publish', 'timings'])
      expect(jobs[name]['runs-on']).toBe('ubuntu-latest');
  });
  it('runs workflow-owned source refusal before a historical build and inspects restored bytes even on cache hits', () => {
    const pipeline = workflow('mobile-store-videos-pipeline').jobs;
    const measurement = workflow('mobile-store-videos-measure').jobs.record;
    for (const job of [pipeline.app, measurement]) {
      const tools = job.steps.find((step) => step.with?.path === '.boardsesh/video-arch-tools');
      expect(tools?.with).toMatchObject({
        ref: '${{ github.workflow_sha }}',
        'persist-credentials': false,
      });
      expect(String(tools?.with?.['sparse-checkout']).trim().split('\n')).toContain(
        'scripts/lib/ios-simulator-architecture.mjs',
      );
      const source = job.steps.findIndex((step) => step.run?.endsWith(' source .'));
      const build = job.steps.findIndex((step) => step.run?.includes('mobile:build-sim-app'));
      const validate = job.steps.findIndex((step) => step.name === 'Validate actual simulator app slices before use');
      const save = job.steps.findIndex((step) => step.uses === 'actions/cache/save@v4');
      expect(source).toBeGreaterThan(-1);
      expect(source).toBeLessThan(build);
      expect(validate).toBeGreaterThan(build);
      expect(validate).toBeLessThan(save);
      expect(job.steps[validate].if).toBe(job === measurement ? "inputs.mode != 'record-crew'" : undefined);
      expect(job.steps.find((step) => step.uses === 'actions/cache/restore@v4')?.with?.['lookup-only']).not.toBe(true);
      expect(job.steps.find((step) => step.name === 'Compute screenshot app cache key')?.run).toContain(
        '${{ runner.arch }}',
      );
      expect(job.steps.find((step) => step.name === 'Compute screenshot app cache key')?.run).toContain(
        'scripts/lib/ios-simulator-architecture.mjs',
      );
    }
    for (const name of ['record', 'crew']) {
      const job = pipeline[name];
      const restore = job.steps.findIndex((step) => step.uses === './.github/actions/ios-store-video-tools');
      const validate = job.steps.findIndex(
        (step) => step.name === 'Validate restored app slices before recorder installation',
      );
      const capture = job.steps.findIndex((step) => step.run?.includes('video:record'));
      expect(validate).toBeGreaterThan(restore);
      expect(validate).toBeLessThan(capture);
      expect(job.steps[validate].if).toBeUndefined();
      expect(job.steps[validate].run).toContain(
        '.boardsesh/video-arch-tools/scripts/lib/ios-simulator-architecture.mjs app',
      );
      expect(job.steps[validate].env?.VIDEO_APP_CACHE_KEY).toBe('${{ needs.app.outputs.cache-key }}');
    }
  });
});
