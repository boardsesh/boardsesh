#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_TARGET_NAME = 'BoardseshTests';
const APP_TARGET_NAME = 'Boardsesh';
const BUNDLE_IDENTIFIER = 'com.boardsesh.app.tests';
const DEPLOYMENT_TARGET = '17.0';
const SWIFT_FLAGS = '"$(inherited) -D WIDGET_EXTENSION"';

const TEST_SOURCE_FILES = [
  {
    sourcePath: '../ios-tests/LiveActivityWidgetTests.swift',
    projectPath: 'BoardseshTests/LiveActivityWidgetTests.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/ClimbSessionAttributes.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/ClimbSessionAttributes.swift',
  },
  {
    sourcePath: '../modules/live-activity/ios/SharedConstants.swift',
    projectPath: 'BoardseshTests/LiveActivitySources/SharedConstants.swift',
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
  const candidates = [
    'xcode',
    join(repoRoot, 'node_modules/.bun/node_modules/xcode'),
    join(repoRoot, 'packages/mobile/node_modules/.bun/node_modules/xcode'),
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }

  throw new Error('Could not load the xcode package. Run `bun install --frozen-lockfile` before this script.');
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

function hasSourceBuildFile(project, targetUuid, sourcePath) {
  const phase = project.pbxSourcesBuildPhaseObj(targetUuid);
  const fileReferenceSection = project.pbxFileReferenceSection();
  const buildFileSection = project.pbxBuildFileSection();
  const expectedBasename = sourcePath.split('/').at(-1);

  return phase.files.some((entry) => {
    const buildFile = buildFileSection[entry.value];
    const fileReference = buildFile ? fileReferenceSection[buildFile.fileRef] : null;
    return unquote(fileReference?.path) === sourcePath || entry.comment === `${expectedBasename} in Sources`;
  });
}

function addSourceFile(project, targetUuid, groupKey, sourcePath) {
  const absolutePath = resolve(projectDir, sourcePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing RN iOS test source: ${absolutePath}`);
  }
  if (!hasSourceBuildFile(project, targetUuid, sourcePath)) {
    project.addSourceFile(sourcePath, { target: targetUuid }, groupKey);
  }
}

function pruneUnexpectedSourceFiles(project, targetUuid) {
  const allowedSourcePaths = new Set(TEST_SOURCE_FILES.map(({ projectPath }) => projectPath));
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

function setBuildSettings(project, targetUuid) {
  const target = project.pbxNativeTargetSection()[targetUuid];
  const configurationList = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const buildConfigurationSection = project.pbxXCBuildConfigurationSection();

  for (const configuration of configurationList.buildConfigurations) {
    const buildSettings = buildConfigurationSection[configuration.value].buildSettings;
    delete buildSettings.INFOPLIST_FILE;

    buildSettings.BUNDLE_LOADER = '""';
    buildSettings.ENABLE_TESTABILITY = 'YES';
    buildSettings.GENERATE_INFOPLIST_FILE = 'YES';
    buildSettings.IPHONEOS_DEPLOYMENT_TARGET = DEPLOYMENT_TARGET;
    buildSettings.LD_RUNPATH_SEARCH_PATHS = '"$(inherited) @executable_path/Frameworks @loader_path/Frameworks"';
    buildSettings.MARKETING_VERSION = '1.0';
    buildSettings.OTHER_SWIFT_FLAGS = SWIFT_FLAGS;
    buildSettings.PRODUCT_BUNDLE_IDENTIFIER = BUNDLE_IDENTIFIER;
    buildSettings.PRODUCT_NAME = '"$(TARGET_NAME)"';
    buildSettings.SWIFT_VERSION = '5.0';
    buildSettings.TEST_HOST = '""';
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
  pruneUnexpectedSourceFiles(project, targetUuid);
  for (const { sourcePath, projectPath } of TEST_SOURCE_FILES) {
    stageSourceFile(sourcePath, projectPath);
    addSourceFile(project, targetUuid, groupKey, projectPath);
  }
  for (const frameworkName of SYSTEM_FRAMEWORKS) {
    addFrameworkToTarget(project, targetUuid, frameworkName);
  }

  setBuildSettings(project, targetUuid);
  return targetUuid;
}

function testBuildableReference(testTargetUuid, indentation) {
  return `${indentation}<BuildableReference
${indentation}   BuildableIdentifier = "primary"
${indentation}   BlueprintIdentifier = "${testTargetUuid}"
${indentation}   BuildableName = "${TEST_TARGET_NAME}.xctest"
${indentation}   BlueprintName = "${TEST_TARGET_NAME}"
${indentation}   ReferencedContainer = "container:Boardsesh.xcodeproj">
${indentation}</BuildableReference>`;
}

function writeTestScheme(testTargetUuid) {
  const schemeDirectory = join(projectDir, 'Boardsesh.xcodeproj/xcshareddata/xcschemes');
  const schemePath = join(schemeDirectory, `${TEST_TARGET_NAME}.xcscheme`);
  mkdirSync(schemeDirectory, { recursive: true });

  const scheme = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1130"
   version = "1.3">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "NO"
            buildForProfiling = "NO"
            buildForArchiving = "NO"
            buildForAnalyzing = "YES">
${testBuildableReference(testTargetUuid, '            ')}
         </BuildActionEntry>
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
${testBuildableReference(testTargetUuid, '            ')}
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

  if (!scheme.includes(`BlueprintIdentifier = "${testTargetUuid}"`)) {
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
removeStaleSdkFrameworkSearchPaths(project);
writeFileSync(projectFilePath, project.writeSync());
writeTestScheme(testTargetUuid);

console.log(`Prepared ${TEST_TARGET_NAME} (${testTargetUuid}) for RN iOS Swift tests.`);
