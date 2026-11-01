/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IOS_UI_SOURCE_COMMIT, stageIosUiDriver } from './mobile-profile-ios-driver';
import { sha256 } from './lib/mobile-profile-protocol';
import { record, string } from './board-qa/config';

export const BOARD_QA_RUNNER_ID = 'com.boardsesh.boardqa.runner';
export const BOARD_QA_WDA_PORT = 8211;
const RECEIPT = 'board-qa-driver.json';

function deviceId(candidate: unknown): string {
  const device = string(candidate);
  if (!/^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{16}|[0-9a-fA-F]{40})$/.test(device))
    throw new Error('Select an explicit physical iPhone UDID');
  return device;
}

/** Source staging only. Building and launching are separate, explicit local commands. */
export function stageBoardQaIosDriver(source: string, stage: string, device: string, team: string) {
  deviceId(device);
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('An explicit Apple development team ID is required');
  const directory = resolve(stage);
  const handoff = stageIosUiDriver(resolve(source), directory, device, team, BOARD_QA_RUNNER_ID);
  const receipt = {
    schemaVersion: 1,
    device,
    runnerBundleId: `${BOARD_QA_RUNNER_ID}.xctrunner`,
    sourceCommit: handoff.sourceCommit,
    sourcePatchSha256: handoff.sourcePatchSha256,
  };
  writeFileSync(join(directory, RECEIPT), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return {
    ...receipt,
    stageDirectory: directory,
    nativeBuildExecuted: false,
    build: { executable: 'vp', arguments: ['exec', handoff.buildExecutable, ...handoff.buildArguments] },
    prepareLaunch: {
      executable: 'vp',
      arguments: ['exec', 'tsx', 'scripts/board-qa-ios-driver.ts', 'prepare-launch', directory],
    },
    notes:
      'Run build first, then prepare-launch. Neither command uninstalls Boardsesh or clears its storage. Launch preparation prints the exact runner and USB-forward commands.',
  };
}

const PATCH_XCTESTRUN = String.raw`
import json, plistlib, sys
source, destination, expected_bundle, port = sys.argv[1:]
with open(source, "rb") as handle:
    specification = plistlib.load(handle)
patched = 0
def visit(node, key=None):
    global patched
    if isinstance(node, dict):
        if node.get("BlueprintName") == "WebDriverAgentRunner" or key == "WebDriverAgentRunner":
            bundle = node.get("TestHostBundleIdentifier")
            if bundle is not None and bundle != expected_bundle:
                raise ValueError("Built runner bundle does not match the owned QA runner")
            environment = node.setdefault("EnvironmentVariables", {})
            if not isinstance(environment, dict):
                raise ValueError("Unexpected runner environment")
            environment["USE_PORT"] = port
            patched += 1
        for child_key, child in node.items():
            visit(child, child_key)
    elif isinstance(node, list):
        for child in node:
            visit(child)
visit(specification)
if patched == 0:
    raise ValueError("No WebDriverAgentRunner target in the built xctestrun")
with open(destination, "wb") as handle:
    plistlib.dump(specification, handle)
print(json.dumps({"targets": patched}))
`;

/** Prepare the built runner's environment; this does not contact or mutate a phone. */
export function prepareBoardQaIosLaunch(stage: string) {
  const directory = realpathSync(resolve(stage));
  const receipt = record(JSON.parse(readFileSync(join(directory, RECEIPT), 'utf8')) as unknown);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.runnerBundleId !== `${BOARD_QA_RUNNER_ID}.xctrunner` ||
    receipt.sourceCommit !== IOS_UI_SOURCE_COMMIT
  )
    throw new Error('Not an owned pinned board-QA driver stage');
  const device = deviceId(receipt.device);
  const project = join(directory, 'WebDriverAgent/WebDriverAgent.xcodeproj/project.pbxproj');
  const status = join(directory, 'WebDriverAgent/WebDriverAgentLib/Commands/FBSessionCommands.m');
  if (sha256(Buffer.concat([readFileSync(project), readFileSync(status)])) !== receipt.sourcePatchSha256)
    throw new Error('Staged driver source changed after its receipt');
  const products = join(directory, 'derivedData/Build/Products');
  const candidates = readdirSync(products).filter(
    (name) => name.endsWith('.xctestrun') && name !== 'BoardseshBoardQa.xctestrun',
  );
  if (candidates.length !== 1) throw new Error('Build the owned runner first; require exactly one original xctestrun');
  const original = join(products, candidates[0]);
  const launch = join(products, 'BoardseshBoardQa.xctestrun');
  // Keep the generated copy beside the original: __TESTROOT__ is relative to
  // this directory, so moving it to the stage root would break product paths.
  execFileSync(
    'python3',
    ['-c', PATCH_XCTESTRUN, original, launch, String(receipt.runnerBundleId), String(BOARD_QA_WDA_PORT)],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const instructions = {
    schemaVersion: 1,
    device,
    runnerBundleId: receipt.runnerBundleId,
    sourceCommit: receipt.sourceCommit,
    launch: {
      executable: 'vp',
      arguments: [
        'exec',
        'xcodebuild',
        'test-without-building',
        '-xctestrun',
        launch,
        '-destination',
        `id=${device}`,
        '-only-testing:WebDriverAgentRunner/UITestingUITests/testRunner',
      ],
    },
    usbForward: {
      executable: 'vp',
      arguments: [
        'exec',
        'python3',
        'scripts/board-qa/usb-forward.py',
        '--device',
        device,
        '--port',
        String(BOARD_QA_WDA_PORT),
      ],
    },
    statusUrl: `http://127.0.0.1:${BOARD_QA_WDA_PORT}/status`,
    notes:
      'Keep launch and usbForward running in separate terminals. Then run qa:boards doctor; it verifies this runner PID on the selected phone before attaching. Stop only these owned terminal processes after QA.',
  };
  writeFileSync(join(directory, 'launch.json'), JSON.stringify(instructions, null, 2) + '\n', { mode: 0o600 });
  return instructions;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const [action, ...argumentsList] = argv.filter((argument) => argument !== '--');
  if (action === 'stage' && argumentsList.length === 4) {
    console.log(JSON.stringify(stageBoardQaIosDriver(...(argumentsList as [string, string, string, string])), null, 2));
  } else if (action === 'prepare-launch' && argumentsList.length === 1) {
    console.log(JSON.stringify(prepareBoardQaIosLaunch(argumentsList[0]), null, 2));
  } else
    throw new Error(
      'Usage: qa:boards:ios-driver stage <pinned-source> <fresh-stage> <physical-udid> <team-id> | prepare-launch <stage>',
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
