/// <reference types="node" />

import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_PROJECT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/prepare-rn-ios-tests/Boardsesh.xcodeproj/project.pbxproj',
);
const PREPARE_SCRIPT = resolve(REPO_ROOT, 'scripts/prepare-rn-ios-tests.mjs');
const TEST_TARGET_NAME = 'BoardseshTests';
const CONCURRENCY_GATE_TARGET_NAME = 'LiveActivityIntentDiagnosticsConcurrencyGate';
const TEST_DIAGNOSTICS_PROJECT_PATH = 'BoardseshTests/LiveActivitySources/LiveActivityIntentDiagnostics.swift';
const CONCURRENCY_GATE_DIAGNOSTICS_PROJECT_PATH =
  'LiveActivityIntentDiagnosticsConcurrencyGate/LiveActivityIntentDiagnostics.swift';
const SWIFT_FLAGS = '"$(inherited) -D WIDGET_EXTENSION -D BOARDSESH_TESTS"';

// Non-live-activity module sources the generator also stages into the test target,
// as `<packages/mobile-relative source path>` -> `<path inside the project>`.
const BOARD_RENDERER_SOURCE_PATH = 'modules/board-renderer/ios/BoardRendererErrorClassification.swift';
const BOARD_RENDERER_PROJECT_PATH = 'BoardseshTests/BoardRendererSources/BoardRendererErrorClassification.swift';

const MODULE_SOURCE_NAMES = [
  'BoardBleManager.swift',
  'BoardBleWriteSeams.swift',
  'WaiterPool.swift',
  'ClimbSessionAttributes.swift',
  'BoardBleEncoding.swift',
  'BoardPlacementData.swift',
  'SharedConstants.swift',
  'SessionQueueState.swift',
  'SharedKeychain.swift',
  'WidgetNetworking.swift',
  'LiveActivityIntentDiagnostics.swift',
  'ClimbNavigationIntent.swift',
  'NextClimbIntent.swift',
  'PreviousClimbIntent.swift',
  'TakeControlIntent.swift',
  'ReconnectBoardIntent.swift',
];

type PbxObject = Record<string, unknown>;
type PbxSection = Record<string, PbxObject | string>;
type PbxObjects = Record<string, PbxSection>;
type PbxReference = { value: string; comment?: string };
type XmlNode = { $?: Record<string, string>; [key: string]: XmlNode[] | Record<string, string> | undefined };

const require = createRequire(import.meta.url);
// Both are root devDependencies, so plain specifiers avoid store-layout coupling.
const xcode = require('xcode');
const { parseStringPromise } = require('xml2js') as {
  parseStringPromise: (xml: string) => Promise<XmlNode>;
};

function asObject(value: unknown, description: string): PbxObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${description} to be a PBX object`);
  }
  return value as PbxObject;
}

function asReferences(value: unknown, description: string): PbxReference[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${description} to be a PBX reference array`);
  }
  return value.map((entry) => asObject(entry, description) as PbxReference);
}

function unquote(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : '';
}

function parseProject(projectPath: string): PbxObjects {
  const project = xcode.project(projectPath).parseSync();
  return project.hash.project.objects as PbxObjects;
}

function findTargets(objects: PbxObjects, targetName: string): Array<{ uuid: string; target: PbxObject }> {
  return Object.entries(objects.PBXNativeTarget).flatMap(([uuid, target]) => {
    if (uuid.endsWith('_comment') || typeof target === 'string') return [];
    const targetObject = asObject(target, `${targetName} target`);
    return unquote(targetObject.name) === targetName ? [{ uuid, target: targetObject }] : [];
  });
}

function targetBuildSettings(objects: PbxObjects, target: PbxObject): PbxObject[] {
  const configurationListUuid = target.buildConfigurationList;
  if (typeof configurationListUuid !== 'string') {
    throw new Error('Target has no build configuration list');
  }
  const configurationList = asObject(objects.XCConfigurationList[configurationListUuid], 'configuration list');
  return asReferences(configurationList.buildConfigurations, 'build configurations').map((configuration) => {
    const configurationObject = asObject(objects.XCBuildConfiguration[configuration.value], 'build configuration');
    return asObject(configurationObject.buildSettings, 'build settings');
  });
}

function targetSourceBuildFiles(objects: PbxObjects, target: PbxObject): PbxObject[] {
  const sourcesPhaseReference = asReferences(target.buildPhases, 'target build phases').find((phaseReference) => {
    return objects.PBXSourcesBuildPhase[phaseReference.value] !== undefined;
  });
  const sourcesPhase = sourcesPhaseReference
    ? asObject(objects.PBXSourcesBuildPhase[sourcesPhaseReference.value], 'build phase')
    : undefined;
  if (!sourcesPhase) throw new Error('Target has no Sources build phase');

  return asReferences(sourcesPhase.files, 'source build files').map((buildFileReference) => {
    return asObject(objects.PBXBuildFile[buildFileReference.value], 'source build file');
  });
}

function sourcePaths(objects: PbxObjects, target: PbxObject): string[] {
  return targetSourceBuildFiles(objects, target).map((buildFile) => {
    if (typeof buildFile.fileRef !== 'string') throw new Error('Source build file has no file reference');
    const fileReference = asObject(objects.PBXFileReference[buildFile.fileRef], 'source file reference');
    return unquote(fileReference.path);
  });
}

function targetDependencyCount(objects: PbxObjects, target: PbxObject, dependencyTargetUuid: string): number {
  return asReferences(target.dependencies, 'target dependencies').filter((dependency) => {
    const dependencyObject = asObject(objects.PBXTargetDependency[dependency.value], 'target dependency');
    return dependencyObject.target === dependencyTargetUuid;
  }).length;
}

function xmlChildren(node: XmlNode | undefined, elementName: string): XmlNode[] {
  const children = node?.[elementName];
  return Array.isArray(children) ? (children as XmlNode[]) : [];
}

function copyFixtureSource(sourcePath: string, fixtureMobileRoot: string) {
  const sourceFilePath = resolve(REPO_ROOT, 'packages/mobile', sourcePath);
  const fixtureFilePath = resolve(fixtureMobileRoot, sourcePath);
  mkdirSync(dirname(fixtureFilePath), { recursive: true });
  copyFileSync(sourceFilePath, fixtureFilePath);
}

function createFixtureProject() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'boardsesh-rn-ios-tests-'));
  const fixtureMobileRoot = join(fixtureRoot, 'packages/mobile');
  const projectPath = join(fixtureMobileRoot, 'ios/Boardsesh.xcodeproj/project.pbxproj');
  mkdirSync(dirname(projectPath), { recursive: true });
  copyFileSync(FIXTURE_PROJECT, projectPath);

  for (const testSourceName of readdirSync(resolve(REPO_ROOT, 'packages/mobile/ios-tests')).filter((name) =>
    name.endsWith('.swift'),
  )) {
    copyFixtureSource(`ios-tests/${testSourceName}`, fixtureMobileRoot);
  }
  for (const moduleSourceName of MODULE_SOURCE_NAMES) {
    copyFixtureSource(`modules/live-activity/ios/${moduleSourceName}`, fixtureMobileRoot);
  }
  copyFixtureSource(BOARD_RENDERER_SOURCE_PATH, fixtureMobileRoot);

  return { fixtureRoot, projectPath };
}

function runGenerator(projectPath: string) {
  execFileSync('node', [PREPARE_SCRIPT, projectPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function seedStaleStrictConcurrencySettings(projectPath: string) {
  const project = xcode.project(projectPath).parseSync();
  const objects = project.hash.project.objects as PbxObjects;
  const [testTarget] = findTargets(objects, TEST_TARGET_NAME);
  if (!testTarget) throw new Error(`Fixture is missing ${TEST_TARGET_NAME}`);

  for (const buildSettings of targetBuildSettings(objects, testTarget.target)) {
    buildSettings.OTHER_SWIFT_FLAGS = '"$(inherited) -strict-concurrency=complete -warnings-as-errors"';
    buildSettings.SWIFT_STRICT_CONCURRENCY = 'complete';
    buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS = 'YES';
  }

  const diagnosticBuildFile = targetSourceBuildFiles(objects, testTarget.target).find((buildFile) => {
    if (typeof buildFile.fileRef !== 'string') return false;
    const fileReference = asObject(objects.PBXFileReference[buildFile.fileRef], 'source file reference');
    return unquote(fileReference.path) === TEST_DIAGNOSTICS_PROJECT_PATH;
  });
  if (!diagnosticBuildFile) throw new Error('Fixture is missing the staged diagnostics source');
  diagnosticBuildFile.settings = { COMPILER_FLAGS: '"-strict-concurrency=complete -warnings-as-errors"' };

  writeFileSync(projectPath, project.writeSync());
}

describe('prepare-rn-ios-tests generated project', () => {
  it('creates an idempotent strict-concurrency diagnostics gate without widening BoardseshTests', async () => {
    const { fixtureRoot, projectPath } = createFixtureProject();

    try {
      runGenerator(projectPath);
      seedStaleStrictConcurrencySettings(projectPath);
      runGenerator(projectPath);

      const normalizedProject = readFileSync(projectPath, 'utf8');
      const schemePath = join(dirname(projectPath), 'xcshareddata/xcschemes/BoardseshTests.xcscheme');
      const normalizedScheme = readFileSync(schemePath, 'utf8');
      runGenerator(projectPath);
      expect(readFileSync(projectPath, 'utf8')).toBe(normalizedProject);
      expect(readFileSync(schemePath, 'utf8')).toBe(normalizedScheme);

      const objects = parseProject(projectPath);
      const testTargets = findTargets(objects, TEST_TARGET_NAME);
      const gateTargets = findTargets(objects, CONCURRENCY_GATE_TARGET_NAME);
      expect(testTargets).toHaveLength(1);
      expect(gateTargets).toHaveLength(1);

      const [{ uuid: testTargetUuid, target: testTarget }] = testTargets;
      const [{ uuid: gateTargetUuid, target: gateTarget }] = gateTargets;
      const expectedTestSources = [
        ...readdirSync(resolve(REPO_ROOT, 'packages/mobile/ios-tests'))
          .filter((name) => name.endsWith('.swift'))
          .sort()
          .map((name) => `BoardseshTests/${name}`),
        ...MODULE_SOURCE_NAMES.map((name) => `BoardseshTests/LiveActivitySources/${name}`),
        BOARD_RENDERER_PROJECT_PATH,
      ].sort();

      expect(sourcePaths(objects, testTarget).sort()).toEqual(expectedTestSources);
      expect(sourcePaths(objects, gateTarget)).toEqual([CONCURRENCY_GATE_DIAGNOSTICS_PROJECT_PATH]);
      expect(sourcePaths(objects, testTarget)).toContain(TEST_DIAGNOSTICS_PROJECT_PATH);

      for (const buildSettings of targetBuildSettings(objects, testTarget)) {
        expect(buildSettings.OTHER_SWIFT_FLAGS).toBe(SWIFT_FLAGS);
        expect(buildSettings.SWIFT_STRICT_CONCURRENCY).toBeUndefined();
        expect(buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS).toBeUndefined();
      }
      for (const buildSettings of targetBuildSettings(objects, gateTarget)) {
        expect(buildSettings.EXECUTABLE_PREFIX).toBe('""');
        expect(buildSettings.OTHER_SWIFT_FLAGS).toBe(SWIFT_FLAGS);
        expect(buildSettings.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
        expect(buildSettings.SUPPORTED_PLATFORMS).toBe('"iphoneos iphonesimulator"');
        expect(buildSettings.SWIFT_VERSION).toBe('5.0');
        expect(buildSettings.SWIFT_STRICT_CONCURRENCY).toBe('complete');
        expect(buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS).toBe('YES');
      }

      expect(unquote(gateTarget.productType)).toBe('com.apple.product-type.library.static');
      if (typeof gateTarget.productReference !== 'string') {
        throw new Error(`${CONCURRENCY_GATE_TARGET_NAME} has no product reference`);
      }
      const gateProductReference = asObject(
        objects.PBXFileReference[gateTarget.productReference],
        `${CONCURRENCY_GATE_TARGET_NAME} product reference`,
      );
      expect(unquote(gateProductReference.path)).toBe(`${CONCURRENCY_GATE_TARGET_NAME}.a`);
      expect(unquote(gateProductReference.explicitFileType)).toBe('archive.ar');

      for (const target of [testTarget, gateTarget]) {
        for (const buildFile of targetSourceBuildFiles(objects, target)) {
          expect(asObject(buildFile.settings ?? {}, 'source build file settings').COMPILER_FLAGS).toBeUndefined();
        }
      }

      expect(targetDependencyCount(objects, testTarget, gateTargetUuid)).toBe(1);

      const parsedScheme = await parseStringPromise(normalizedScheme);
      const scheme = parsedScheme.Scheme as unknown as XmlNode;
      const buildActionEntries = xmlChildren(
        xmlChildren(xmlChildren(scheme, 'BuildAction')[0], 'BuildActionEntries')[0],
        'BuildActionEntry',
      );
      const buildableReferences = buildActionEntries.map((entry) => {
        return xmlChildren(entry, 'BuildableReference')[0]?.$;
      });
      expect(buildableReferences.map((reference) => reference?.BlueprintName)).toEqual([
        TEST_TARGET_NAME,
        CONCURRENCY_GATE_TARGET_NAME,
      ]);
      const concurrencyGateBuildableReference = buildableReferences[1];
      expect(concurrencyGateBuildableReference?.BlueprintIdentifier).toBe(gateTargetUuid);
      expect(concurrencyGateBuildableReference?.BuildableName).toBe(`${CONCURRENCY_GATE_TARGET_NAME}.a`);
      const testableNames = xmlChildren(
        xmlChildren(xmlChildren(scheme, 'TestAction')[0], 'Testables')[0],
        'TestableReference',
      ).map((entry) => xmlChildren(entry, 'BuildableReference')[0]?.$?.BlueprintName);
      expect(testableNames).toEqual([TEST_TARGET_NAME]);
      expect(testTargetUuid).not.toBe(gateTargetUuid);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
