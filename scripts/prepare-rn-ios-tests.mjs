#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_TARGET_NAME = 'BoardseshTests';
const CONCURRENCY_GATE_TARGET_NAME = 'LiveActivityIntentDiagnosticsConcurrencyGate';
const APP_TARGET_NAME = 'Boardsesh';
const BUNDLE_IDENTIFIER = 'com.boardsesh.app.tests';
const DEPLOYMENT_TARGET = '17.0';
const SWIFT_FLAGS = '"$(inherited) -D WIDGET_EXTENSION -D BOARDSESH_TESTS"';
const DIAGNOSTICS_SOURCE_PATH = '../modules/live-activity/ios/LiveActivityIntentDiagnostics.swift';
const TEST_DIAGNOSTICS_PROJECT_PATH = 'BoardseshTests/LiveActivitySources/LiveActivityIntentDiagnostics.swift';
const CONCURRENCY_GATE_DIAGNOSTICS_PROJECT_PATH =
  'LiveActivityIntentDiagnosticsConcurrencyGate/LiveActivityIntentDiagnostics.swift';

const TEST_SOURCE_FILES = [
  {
    sourcePath: '../ios-tests/LiveActivityWidgetTests.swift',
    projectPath: 'BoardseshTests/LiveActivityWidgetTests.swift',
  },
  {
    sourcePath: '../ios-tests/BoardBleWriteFlowTests.swift',
    projectPath: 'BoardseshTests/BoardBleWriteFlowTests.swift',
  },
  {
    sourcePath: '../ios-tests/BoardBleImplicitRelightStateTests.swift',
    projectPath: 'BoardseshTests/BoardBleImplicitRelightStateTests.swift',
  },
  {
    sourcePath: '../ios-tests/BoardBleDisconnectTests.swift',
    projectPath: 'BoardseshTests/BoardBleDisconnectTests.swift',
  },
  {
    sourcePath: '../ios-tests/BoardBleServiceDiscoveryTests.swift',
    projectPath: 'BoardseshTests/BoardBleServiceDiscoveryTests.swift',
  },
  {
    sourcePath: '../ios-tests/BoardRendererErrorClassificationTests.swift',
    projectPath: 'BoardseshTests/BoardRendererErrorClassificationTests.swift',
  },
  {
    sourcePath: '../modules/board-renderer/ios/BoardRendererErrorClassification.swift',
    projectPath: 'BoardseshTests/BoardRendererSources/BoardRendererErrorClassification.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/BoardBleManager.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/BoardBleManager.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/BoardBleWriteSeams.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/BoardBleWriteSeams.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/WaiterPool.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/WaiterPool.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/ClimbSessionAttributes.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/ClimbSessionAttributes.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/BoardBleEncoding.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/BoardBleEncoding.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/BoardPlacementData.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/BoardPlacementData.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/SharedConstants.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/SharedConstants.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/SessionQueueState.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/SessionQueueState.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/SharedKeychain.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/SharedKeychain.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/WidgetNetworking.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/WidgetNetworking.swift',
  },
  {
    sourcePath: DIAGNOSTICS_SOURCE_PATH,
    projectPath: TEST_DIAGNOSTICS_PROJECT_PATH,
  },
  {
    sourcePath: '../modules/live-activity/ios/ClimbNavigationIntent.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/ClimbNavigationIntent.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/NextClimbIntent.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/NextClimbIntent.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/PreviousClimbIntent.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/PreviousClimbIntent.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/TakeControlIntent.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/TakeControlIntent.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/ReconnectBoardIntent.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/ReconnectBoardIntent.swift',
  },
];

const CONCURRENCY_GATE_SOURCE_FILES = [
  {
    sourcePath: DIAGNOSTICS_SOURCE_PATH,
    projectPath: CONCURRENCY_GATE_DIAGNOSTICS_PROJECT_PATH,
  },
];

const SYSTEM_FRAMEWORKS = [
  'XCTest.framework',
  'ActivityKit.framework',
  'AppIntents.framework',
  'Foundation.framework',
  'Security.framework',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const projectFilePath = resolve(
  process.argv[2] ?? join(repoRoot, 'packages/mobile/ios/Boardsesh.xcodeproj/project.pbxproj'),
);
const projectDir = dirname(dirname(projectFilePath));

const require = createRequire(import.meta.url);

function loadXcode() {
  // These are root devDependencies so an isolated linker makes them directly
  // resolvable without reaching into its store layout. Keep a compatibility
  // fallback for trees installed before that declaration landed.
  const candidates = ['xcode', join(repoRoot, 'node_modules/.pnpm/node_modules/xcode')];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }

  throw new Error('Could not load the xcode package. Run `vp install --frozen-lockfile` before this script.');
}

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
}

function normalizedBuildSetting(value) {
  return String(value).replaceAll('\\', '').replaceAll('"', '');
}

function isCommentKey(key) {
  return key.endsWith('_comment');
}

function findNativeTarget(project, targetName) {
  const targets = project.pbxNativeTargetSection();
  for (const [uuid, target] of Object.entries(targets)) {
    if (isCommentKey(uuid)) continue;
    if (unquote(target.name) === targetName || unquote(target.productName) === targetName) {
      return { uuid, target };
    }
  }
  return null;
}

function ensureBuildPhase(project, targetUuid, phaseType, comment) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const hasPhase = target.buildPhases.some((phase) => phase.comment === comment);
  if (!hasPhase) {
    project.addBuildPhase([], phaseType, comment, targetUuid);
  }
}

function findGroupKey(project, groupName) {
  const groups = project.hash.project.objects.PBXGroup;
  for (const [uuid, group] of Object.entries(groups)) {
    if (isCommentKey(uuid)) continue;
    if (unquote(group.name) === groupName || unquote(group.path) === groupName) {
      return uuid;
    }
  }
  return null;
}

function ensureGroup(project, groupName) {
  const existingGroupKey = findGroupKey(project, groupName);
  if (existingGroupKey) {
    return existingGroupKey;
  }

  const groupKey = project.pbxCreateGroup(groupName);
  const projectRoot = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(groupKey, projectRoot);
  return groupKey;
}

function findSourceBuildFile(project, targetUuid, sourcePath) {
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const fileReferenceSection = project.pbxFileReferenceSection();
  const buildFileSection = project.pbxBuildFileSection();
  const expectedBasename = sourcePath.split('/').at(-1);

  for (const entry of phase.files) {
    const buildFile = buildFileSection[entry.value];
    const fileReference = buildFile ? fileReferenceSection[buildFile.fileRef] : null;
    if (unquote(fileReference?.path) === sourcePath || entry.comment === `${expectedBasename} in Sources`) {
      return buildFile;
    }
  }

  return null;
}

function addSourceFile(project, targetUuid, groupKey, sourcePath) {
  const absolutePath = resolve(projectDir, sourcePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing RN iOS test source: ${absolutePath}`);
  }

  let buildFile = findSourceBuildFile(project, targetUuid, sourcePath);
  if (!buildFile) {
    project.addSourceFile(sourcePath, { target: targetUuid }, groupKey);
    buildFile = findSourceBuildFile(project, targetUuid, sourcePath);
  }
  if (!buildFile) {
    throw new Error(`Could not add RN iOS test source to the Sources build phase: ${sourcePath}`);
  }
}

function removePerFileCompilerFlags(project, targetUuid) {
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const buildFileSection = project.pbxBuildFileSection();

  for (const entry of phase.files) {
    const buildFile = buildFileSection[entry.value];
    if (buildFile?.settings?.COMPILER_FLAGS === undefined) continue;

    delete buildFile.settings.COMPILER_FLAGS;
    if (Object.keys(buildFile.settings).length === 0) {
      delete buildFile.settings;
    }
  }
}

function targetBuildConfigurations(project, targetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const configurationList = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const buildConfigurationSection = project.pbxXCBuildConfigurationSection();

  return configurationList.buildConfigurations.map((configuration) => buildConfigurationSection[configuration.value]);
}

function assertNoPerFileCompilerFlags(project, targetUuid, targetName) {
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const buildFileSection = project.pbxBuildFileSection();

  for (const entry of phase.files) {
    const buildFile = buildFileSection[entry.value];
    if (buildFile?.settings?.COMPILER_FLAGS !== undefined) {
      throw new Error(`${targetName} must not use unsupported per-file compiler flags`);
    }
  }
}

function assertSourceFiles(project, targetUuid, targetName, sourceFiles) {
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const fileReferenceSection = project.pbxFileReferenceSection();
  const buildFileSection = project.pbxBuildFileSection();
  const expectedPaths = new Set(sourceFiles.map(({ projectPath }) => projectPath));
  const actualPaths = phase.files.map((entry) => {
    const buildFile = buildFileSection[entry.value];
    return unquote(fileReferenceSection[buildFile?.fileRef]?.path);
  });

  if (actualPaths.length !== expectedPaths.size || actualPaths.some((sourcePath) => !expectedPaths.has(sourcePath))) {
    throw new Error(`${targetName} Sources phase does not match its generated source list`);
  }
}

function assertBuildSettings(project, targetUuid, targetName, expectsStrictConcurrency) {
  for (const configuration of targetBuildConfigurations(project, targetUuid)) {
    const buildSettings = configuration.buildSettings;
    if (buildSettings.OTHER_SWIFT_FLAGS !== SWIFT_FLAGS) {
      throw new Error(`${targetName} must retain its widget and test Swift defines`);
    }
    if (buildSettings.IPHONEOS_DEPLOYMENT_TARGET !== DEPLOYMENT_TARGET || buildSettings.SWIFT_VERSION !== '5.0') {
      throw new Error(`${targetName} must retain its iOS deployment target and Swift version`);
    }
    if (buildSettings.SUPPORTED_PLATFORMS !== '"iphoneos iphonesimulator"') {
      throw new Error(`${targetName} must support device and simulator builds`);
    }

    if (expectsStrictConcurrency) {
      if (
        buildSettings.SWIFT_STRICT_CONCURRENCY !== 'complete' ||
        buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS !== 'YES' ||
        buildSettings.EXECUTABLE_PREFIX !== '""'
      ) {
        throw new Error(
          `${targetName} must compile with strict concurrency warnings as errors and an unprefixed executable name`,
        );
      }
    } else if (
      buildSettings.SWIFT_STRICT_CONCURRENCY !== undefined ||
      buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS !== undefined
    ) {
      throw new Error(`${targetName} must not enable strict concurrency`);
    }
  }
}

function pruneUnexpectedSourceFiles(project, targetUuid, sourceFiles) {
  const allowedSourcePaths = new Set(sourceFiles.map(({ projectPath }) => projectPath));
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const fileReferenceSection = project.pbxFileReferenceSection();
  const buildFileSection = project.pbxBuildFileSection();

  phase.files = phase.files.filter((entry) => {
    const buildFile = buildFileSection[entry.value];
    const fileReference = buildFile ? fileReferenceSection[buildFile.fileRef] : null;
    const sourcePath = unquote(fileReference?.path);
    const keep = allowedSourcePaths.has(sourcePath);
    if (!keep) {
      delete buildFileSection[entry.value];
      delete buildFileSection[`${entry.value}_comment`];
    }
    return keep;
  });
}

function stageSourceFile(sourcePath, projectPath) {
  const sourceAbsolutePath = resolve(projectDir, sourcePath);
  const projectAbsolutePath = resolve(projectDir, projectPath);

  if (!existsSync(sourceAbsolutePath)) {
    throw new Error(`Missing tracked RN iOS test source: ${sourceAbsolutePath}`);
  }

  mkdirSync(dirname(projectAbsolutePath), { recursive: true });
  const sourceContents = readFileSync(sourceAbsolutePath);
  if (!existsSync(projectAbsolutePath) || !readFileSync(projectAbsolutePath).equals(sourceContents)) {
    writeFileSync(projectAbsolutePath, sourceContents);
  }
}

function findFrameworkReference(project, frameworkName) {
  const sdkPath = `System/Library/Frameworks/${frameworkName}`;
  const fileReferenceSection = project.pbxFileReferenceSection();
  for (const [uuid, fileReference] of Object.entries(fileReferenceSection)) {
    if (isCommentKey(uuid)) continue;
    if (
      unquote(fileReference.path) === frameworkName ||
      unquote(fileReference.path) === sdkPath ||
      unquote(fileReference.name) === frameworkName
    ) {
      return uuid;
    }
  }
  return null;
}

function addFrameworkReference(project, frameworkName) {
  const fileRef = project.generateUuid();
  project.pbxFileReferenceSection()[fileRef] = {
    isa: 'PBXFileReference',
    fileEncoding: 4,
    includeInIndex: 0,
    lastKnownFileType: 'wrapper.framework',
    name: frameworkName,
    path: `System/Library/Frameworks/${frameworkName}`,
    sourceTree: 'SDKROOT',
  };
  project.pbxFileReferenceSection()[`${fileRef}_comment`] = frameworkName;

  const frameworksGroupKey = findGroupKey(project, 'Frameworks');
  if (frameworksGroupKey) {
    const frameworksGroup = project.hash.project.objects.PBXGroup[frameworksGroupKey];
    const hasFrameworkChild = frameworksGroup.children?.some((child) => child.value === fileRef);
    if (!hasFrameworkChild) {
      frameworksGroup.children ??= [];
      frameworksGroup.children.push({ value: fileRef, comment: frameworkName });
    }
  }

  return fileRef;
}

function ensureFrameworkReference(project, frameworkName) {
  const existingReference = findFrameworkReference(project, frameworkName);
  const fileReference = existingReference ? project.pbxFileReferenceSection()[existingReference] : null;
  if (existingReference && fileReference) {
    fileReference.sourceTree = 'SDKROOT';
    fileReference.path = `System/Library/Frameworks/${frameworkName}`;
    return existingReference;
  }

  return addFrameworkReference(project, frameworkName);
}

function hasFrameworkBuildFile(project, targetUuid, frameworkName) {
  const phase = project.pbxFrameworksBuildPhaseObj(targetUuid);
  return phase.files.some((entry) => entry.comment === `${frameworkName} in Frameworks`);
}

function addFrameworkToTarget(project, targetUuid, frameworkName) {
  const phase = project.pbxFrameworksBuildPhaseObj(targetUuid);
  if (hasFrameworkBuildFile(project, targetUuid, frameworkName)) {
    return;
  }

  const fileRef = ensureFrameworkReference(project, frameworkName);
  const buildFileUuid = project.generateUuid();
  project.pbxBuildFileSection()[buildFileUuid] = {
    isa: 'PBXBuildFile',
    fileRef,
    fileRef_comment: frameworkName,
  };
  project.pbxBuildFileSection()[`${buildFileUuid}_comment`] = `${frameworkName} in Frameworks`;
  phase.files.push({
    value: buildFileUuid,
    comment: `${frameworkName} in Frameworks`,
  });
}

function setTestBuildSettings(project, targetUuid) {
  for (const configuration of targetBuildConfigurations(project, targetUuid)) {
    const buildSettings = configuration.buildSettings;
    delete buildSettings.INFOPLIST_FILE;
    delete buildSettings.SWIFT_STRICT_CONCURRENCY;
    delete buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS;

    buildSettings.BUNDLE_LOADER = '""';
    buildSettings.ENABLE_TESTABILITY = 'YES';
    buildSettings.GENERATE_INFOPLIST_FILE = 'YES';
    buildSettings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    buildSettings.LD_RUNPATH_SEARCH_PATHS = '"$(inherited) @executable_path/Frameworks @loader_path/Frameworks"';
    buildSettings.MARKETING_VERSION = '1.0';
    buildSettings.OTHER_SWIFT_FLAGS = SWIFT_FLAGS;
    buildSettings.PRODUCT_BUNDLE_IDENTIFIER = BUNDLE_IDENTIFIER;
    buildSettings.PRODUCT_NAME = '"$(TARGET_NAME)"';
    buildSettings.SUPPORTED_PLATFORMS = '"iphoneos iphonesimulator"';
    buildSettings.SWIFT_VERSION = '5.0';
    buildSettings.TEST_HOST = '""';
  }
}

function setConcurrencyGateBuildSettings(project, targetUuid) {
  for (const configuration of targetBuildConfigurations(project, targetUuid)) {
    const buildSettings = configuration.buildSettings;
    delete buildSettings.INFOPLIST_FILE;
    delete buildSettings.BUNDLE_LOADER;
    delete buildSettings.TEST_HOST;
    delete buildSettings.PRODUCT_BUNDLE_IDENTIFIER;

    buildSettings.CLANG_ENABLE_MODULES = 'YES';
    buildSettings.EXECUTABLE_PREFIX = '""';
    buildSettings.GENERATE_INFOPLIST_FILE = 'YES';
    buildSettings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    buildSettings.OTHER_SWIFT_FLAGS = SWIFT_FLAGS;
    buildSettings.PRODUCT_NAME = '"$(TARGET_NAME)"';
    buildSettings.SKIP_INSTALL = 'YES';
    buildSettings.SUPPORTED_PLATFORMS = '"iphoneos iphonesimulator"';
    buildSettings.SWIFT_STRICT_CONCURRENCY = 'complete';
    // Deliberate policy: ALL Swift warnings on this gate target become errors, not
    // just concurrency ones — a new SDK/Xcode bump can red the suite on unrelated
    // deprecations. Accepted because the target compiles a single audited file;
    // revisit if an SDK bump reds the suite spuriously.
    buildSettings.SWIFT_TREAT_WARNINGS_AS_ERRORS = 'YES';
    buildSettings.SWIFT_VERSION = '5.0';
    buildSettings.TARGETED_DEVICE_FAMILY = '"1,2"';
  }
}

function assertConcurrencyGateProduct(project, targetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  if (target.productType !== '"com.apple.product-type.library.static"') {
    throw new Error(`${CONCURRENCY_GATE_TARGET_NAME} must be a static library target`);
  }

  const productReference = project.pbxFileReferenceSection()[target.productReference];
  if (
    !productReference ||
    unquote(productReference.path) !== `${CONCURRENCY_GATE_TARGET_NAME}.a` ||
    unquote(productReference.explicitFileType) !== 'archive.ar'
  ) {
    throw new Error(`${CONCURRENCY_GATE_TARGET_NAME} must reference its unprefixed static library product`);
  }
}

function removeStaleSdkFrameworkSearchPaths(project) {
  const buildConfigurationSection = project.pbxXCBuildConfigurationSection();
  for (const [uuid, buildConfiguration] of Object.entries(buildConfigurationSection)) {
    if (isCommentKey(uuid)) continue;

    const buildSettings = buildConfiguration.buildSettings;
    const searchPaths = buildSettings?.FRAMEWORK_SEARCH_PATHS;
    if (Array.isArray(searchPaths)) {
      const filteredSearchPaths = searchPaths.filter(
        (searchPath) => normalizedBuildSetting(searchPath) !== 'System/Library/Frameworks',
      );
      if (filteredSearchPaths.length === 0) {
        delete buildSettings.FRAMEWORK_SEARCH_PATHS;
      } else {
        buildSettings.FRAMEWORK_SEARCH_PATHS = filteredSearchPaths;
      }
    } else if (searchPaths && normalizedBuildSetting(searchPaths) === 'System/Library/Frameworks') {
      delete buildSettings.FRAMEWORK_SEARCH_PATHS;
    }
  }
}

function ensureTestTarget(project) {
  const existingTarget = findNativeTarget(project, TEST_TARGET_NAME);
  const targetUuid =
    existingTarget?.uuid ??
    project.addTarget(TEST_TARGET_NAME, 'unit_test_bundle', TEST_TARGET_NAME, BUNDLE_IDENTIFIER).uuid;

  ensureBuildPhase(project, targetUuid, 'PBXSourcesBuildPhase', 'Sources');
  ensureBuildPhase(project, targetUuid, 'PBXFrameworksBuildPhase', 'Frameworks');
  ensureBuildPhase(project, targetUuid, 'PBXResourcesBuildPhase', 'Resources');

  const groupKey = ensureGroup(project, TEST_TARGET_NAME);
  pruneUnexpectedSourceFiles(project, targetUuid, TEST_SOURCE_FILES);
  removePerFileCompilerFlags(project, targetUuid);
  for (const { sourcePath, projectPath } of TEST_SOURCE_FILES) {
    stageSourceFile(sourcePath, projectPath);
    addSourceFile(project, targetUuid, groupKey, projectPath);
  }
  for (const frameworkName of SYSTEM_FRAMEWORKS) {
    addFrameworkToTarget(project, targetUuid, frameworkName);
  }

  setTestBuildSettings(project, targetUuid);
  assertSourceFiles(project, targetUuid, TEST_TARGET_NAME, TEST_SOURCE_FILES);
  assertNoPerFileCompilerFlags(project, targetUuid, TEST_TARGET_NAME);
  assertBuildSettings(project, targetUuid, TEST_TARGET_NAME, false);
  return targetUuid;
}

function removeTargetDependencies(project, targetUuid, dependencyTargetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const targetDependencySection = project.hash.project.objects.PBXTargetDependency;
  const containerItemProxySection = project.hash.project.objects.PBXContainerItemProxy;

  const dependenciesToRemove = (target.dependencies ?? []).filter((dependency) => {
    return targetDependencySection[dependency.value]?.target === dependencyTargetUuid;
  });

  if (dependenciesToRemove.length === 0) return 0;

  const dependencyUuids = new Set(dependenciesToRemove.map((dependency) => dependency.value));
  target.dependencies = target.dependencies.filter((dependency) => !dependencyUuids.has(dependency.value));
  for (const dependencyUuid of dependencyUuids) {
    const targetDependency = targetDependencySection[dependencyUuid];
    delete targetDependencySection[dependencyUuid];
    delete targetDependencySection[`${dependencyUuid}_comment`];

    if (targetDependency?.targetProxy) {
      delete containerItemProxySection[targetDependency.targetProxy];
      delete containerItemProxySection[`${targetDependency.targetProxy}_comment`];
    }
  }

  return dependenciesToRemove.length;
}

function ensureConcurrencyGateDependency(project, testTargetUuid, gateTargetUuid) {
  const nativeTargets = project.pbxNativeTargetSection();
  for (const [targetUuid] of Object.entries(nativeTargets)) {
    if (isCommentKey(targetUuid) || targetUuid === testTargetUuid) continue;
    removeTargetDependencies(project, targetUuid, gateTargetUuid);
  }

  const targetDependencySection = project.hash.project.objects.PBXTargetDependency;
  const testTarget = nativeTargets[testTargetUuid];
  const gateDependencies = (testTarget.dependencies ?? []).filter(
    (dependency) => targetDependencySection[dependency.value]?.target === gateTargetUuid,
  );

  if (gateDependencies.length === 1) return;

  removeTargetDependencies(project, testTargetUuid, gateTargetUuid);
  project.addTargetDependency(testTargetUuid, [gateTargetUuid]);
}

function assertConcurrencyGateDependency(project, testTargetUuid, gateTargetUuid) {
  const targetDependencySection = project.hash.project.objects.PBXTargetDependency;
  const testTarget = project.pbxNativeTargetSection()[testTargetUuid];
  const gateDependencyCount = (testTarget.dependencies ?? []).filter(
    (dependency) => targetDependencySection[dependency.value]?.target === gateTargetUuid,
  ).length;

  if (gateDependencyCount !== 1) {
    throw new Error(`${TEST_TARGET_NAME} must depend on ${CONCURRENCY_GATE_TARGET_NAME}`);
  }
}

function ensureConcurrencyGateTarget(project) {
  const existingTarget = findNativeTarget(project, CONCURRENCY_GATE_TARGET_NAME);
  const targetUuid =
    existingTarget?.uuid ??
    project.addTarget(CONCURRENCY_GATE_TARGET_NAME, 'static_library', CONCURRENCY_GATE_TARGET_NAME).uuid;

  ensureBuildPhase(project, targetUuid, 'PBXSourcesBuildPhase', 'Sources');

  const groupKey = ensureGroup(project, CONCURRENCY_GATE_TARGET_NAME);
  pruneUnexpectedSourceFiles(project, targetUuid, CONCURRENCY_GATE_SOURCE_FILES);
  removePerFileCompilerFlags(project, targetUuid);
  for (const { sourcePath, projectPath } of CONCURRENCY_GATE_SOURCE_FILES) {
    stageSourceFile(sourcePath, projectPath);
    addSourceFile(project, targetUuid, groupKey, projectPath);
  }

  setConcurrencyGateBuildSettings(project, targetUuid);
  assertSourceFiles(project, targetUuid, CONCURRENCY_GATE_TARGET_NAME, CONCURRENCY_GATE_SOURCE_FILES);
  assertNoPerFileCompilerFlags(project, targetUuid, CONCURRENCY_GATE_TARGET_NAME);
  assertBuildSettings(project, targetUuid, CONCURRENCY_GATE_TARGET_NAME, true);
  assertConcurrencyGateProduct(project, targetUuid);
  return targetUuid;
}

function buildableReference(targetUuid, targetName, buildableName, indentation) {
  return `${indentation}<BuildableReference
${indentation}   BuildableIdentifier = "primary"
${indentation}   BlueprintIdentifier = "${targetUuid}"
${indentation}   BuildableName = "${buildableName}"
${indentation}   BlueprintName = "${targetName}"
${indentation}   ReferencedContainer = "container:Boardsesh.xcodeproj">
${indentation}</BuildableReference>`;
}

function buildActionEntry(targetUuid, targetName, buildableName) {
  return `         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "NO"
            buildForProfiling = "NO"
            buildForArchiving = "NO"
            buildForAnalyzing = "YES">
${buildableReference(targetUuid, targetName, buildableName, '            ')}
         </BuildActionEntry>`;
}

function writeTestScheme(testTargetUuid, gateTargetUuid) {
  const schemeDirectory = join(projectDir, 'Boardsesh.xcodeproj/xcshareddata/xcschemes');
  const schemePath = join(schemeDirectory, `${TEST_TARGET_NAME}.xcscheme`);
  mkdirSync(schemeDirectory, { recursive: true });

  const testBuildableName = `${TEST_TARGET_NAME}.xctest`;
  const gateBuildableName = `${CONCURRENCY_GATE_TARGET_NAME}.a`;

  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1130"
   version = "1.3">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
${buildActionEntry(testTargetUuid, TEST_TARGET_NAME, testBuildableName)}
${buildActionEntry(gateTargetUuid, CONCURRENCY_GATE_TARGET_NAME, gateBuildableName)}
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference
            skipped = "NO">
${buildableReference(testTargetUuid, TEST_TARGET_NAME, testBuildableName, '            ')}
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;

  if (
    !scheme.includes(`BlueprintIdentifier = "${testTargetUuid}"`) ||
    !scheme.includes(`BlueprintIdentifier = "${gateTargetUuid}"`)
  ) {
    throw new Error(`Could not write ${TEST_TARGET_NAME} scheme at ${schemePath}`);
  }

  writeFileSync(schemePath, scheme);
}

if (!existsSync(projectFilePath)) {
  throw new Error(`Missing generated Xcode project: ${projectFilePath}`);
}

mkdirSync(projectDir, { recursive: true });

const xcode = loadXcode();
const project = xcode.project(projectFilePath).parseSync();
if (!findNativeTarget(project, APP_TARGET_NAME)) {
  throw new Error(`Could not find ${APP_TARGET_NAME} target in ${projectFilePath}`);
}

const testTargetUuid = ensureTestTarget(project);
const concurrencyGateTargetUuid = ensureConcurrencyGateTarget(project);
ensureConcurrencyGateDependency(project, testTargetUuid, concurrencyGateTargetUuid);
assertConcurrencyGateDependency(project, testTargetUuid, concurrencyGateTargetUuid);
removeStaleSdkFrameworkSearchPaths(project);
writeFileSync(projectFilePath, project.writeSync());
writeTestScheme(testTargetUuid, concurrencyGateTargetUuid);

console.log(
  `Prepared ${TEST_TARGET_NAME} (${testTargetUuid}) and ${CONCURRENCY_GATE_TARGET_NAME} (${concurrencyGateTargetUuid}) for RN iOS Swift tests.`,
);
