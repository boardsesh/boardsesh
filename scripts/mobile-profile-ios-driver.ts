/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './lib/mobile-profile-protocol';

export const IOS_UI_RUNNER_ID = 'com.boardsesh.perfprofile.runner';
export const IOS_UI_SOURCE_COMMIT = 'ee71b5903bbaba4f33c150e5e7c5b059f15f6f14';

/** Stage reviewed source only. Root owns native compilation, signing, installation and launch. */
export function stageIosUiDriver(sourceDirectory: string, stageDirectory: string, device: string, teamId: string) {
  if (existsSync(stageDirectory)) throw new Error('Use a fresh owned UI-driver staging directory');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: sourceDirectory,
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  if (sourceCommit !== IOS_UI_SOURCE_COMMIT) throw new Error('UI-driver source is not the reviewed pinned commit');
  if (
    execFileSync('git', ['status', '--porcelain', '--', 'drivers/ios/WebDriverAgent'], {
      cwd: sourceDirectory,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim()
  )
    throw new Error('Pinned vendored WDA source is dirty');
  const source = join(sourceDirectory, 'drivers/ios/WebDriverAgent');
  const staged = join(stageDirectory, 'WebDriverAgent');
  mkdirSync(stageDirectory, { recursive: true });
  cpSync(source, staged, { recursive: true });
  const project = join(staged, 'WebDriverAgent.xcodeproj/project.pbxproj');
  writeFileSync(
    project,
    readFileSync(project, 'utf8').replaceAll('com.facebook.WebDriverAgentRunner', IOS_UI_RUNNER_ID),
  );
  const statusPath = join(staged, 'WebDriverAgentLib/Commands/FBSessionCommands.m');
  const statusSource = readFileSync(statusPath, 'utf8');
  const insertion = '@"productBundleIdentifier" : productBundleIdentifier,';
  if (!statusSource.includes(insertion)) throw new Error('Pinned driver status source differs');
  writeFileSync(
    statusPath,
    statusSource.replace(
      insertion,
      `${insertion}\n    @"profileRunnerBundleId" : NSBundle.mainBundle.bundleIdentifier ?: @"",\n    @"profileRunnerPid" : @(NSProcessInfo.processInfo.processIdentifier),\n    @"profileRunnerSourceCommit" : @"${sourceCommit}",`,
    ),
  );
  const buildArguments = [
    'build-for-testing',
    '-project',
    join(staged, 'WebDriverAgent.xcodeproj'),
    '-scheme',
    'WebDriverAgentRunner',
    '-destination',
    `id=${device}`,
    '-derivedDataPath',
    join(stageDirectory, 'derivedData'),
    '-allowProvisioningUpdates',
    `DEVELOPMENT_TEAM=${teamId}`,
    'CODE_SIGN_STYLE=Automatic',
  ];
  const handoff = {
    schemaVersion: 1,
    sourceCommit,
    source: 'https://github.com/devicelab-dev/maestro-runner',
    wdaVersion: '16.12.8',
    runnerBundleId: `${IOS_UI_RUNNER_ID}.xctrunner`,
    nativeBuildExecuted: false,
    buildExecutable: 'xcodebuild',
    buildArguments,
    launchNotes:
      'Root launches this owned xctestrun only with USE_PORT=8211 (inject xctestrun EnvironmentVariables). Use own USB tunnel or approved private LAN URL. Never terminate a runner by common process name. App attachment uses forceAppLaunch=false and shouldTerminateApp=false.',
    sourcePatchSha256: sha256(Buffer.concat([readFileSync(project), readFileSync(statusPath)])),
  };
  writeFileSync(join(stageDirectory, 'handoff.json'), JSON.stringify(handoff, null, 2) + '\n');
  return handoff;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, stage, device, teamId] = process.argv.slice(2);
  if (!source || !stage || !device || !teamId)
    throw new Error(
      'Usage: vp exec tsx scripts/mobile-profile-ios-driver.ts <pinned-source> <fresh-stage> <physical-udid> <team-id>',
    );
  console.log(JSON.stringify(stageIosUiDriver(resolve(source), resolve(stage), device, teamId), null, 2));
}
