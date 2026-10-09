/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { objectRecord, requiredString } from './lib/mobile-profile-protocol';
import { validateLocalEndpoint } from './lib/mobile-profile-prepare';
import { ownWdaIdentity, PhysicalIosFlow, wdaRequest } from './lib/mobile-profile-wda';
import { assertDeviceProcessPid, iosProcessPid } from './lib/mobile-profile-device';

export async function runPhysicalIosFlow(argv: string[]): Promise<void> {
  const [origin, filename, directory, device] = argv;
  if (!origin || !filename || !directory || !device)
    throw new Error('Usage: physical UI driver requires wda-url flow evidence-directory selected-device');
  await validateLocalEndpoint(origin, 'http:');
  const request = wdaRequest(origin),
    identity = ownWdaIdentity(await request('/status'));
  mkdirSync(directory, { recursive: true });
  const processesPath = join(directory, 'selected-ui-runner-processes.json');
  execFileSync(
    'xcrun',
    ['devicectl', 'device', 'info', 'processes', '--device', device, '--json-output', processesPath],
    { encoding: 'utf8', timeout: 20_000 },
  );
  const processList = objectRecord(
    objectRecord(JSON.parse(readFileSync(processesPath, 'utf8')) as unknown).result,
  ).runningProcesses;
  const expectedAppPid = Number(requiredString(process.env.PROFILE_EXPECTED_APP_PID, 'acknowledged native app PID'));
  assertDeviceProcessPid(expectedAppPid, iosProcessPid({ result: { runningProcesses: processList } }, 'BoardseshPerf'));
  if (
    !Array.isArray(processList) ||
    !processList.some((candidate) => {
      const process = objectRecord(candidate);
      return (
        process.processIdentifier === identity.pid &&
        typeof process.executable === 'string' &&
        process.executable.endsWith('/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner')
      );
    })
  )
    throw new Error('Owned WDA runtime does not match the selected physical device PID');
  writeFileSync(
    join(directory, 'ui-driver-identity.json'),
    JSON.stringify(
      {
        ...identity,
        driver: 'owned-WDA-physical-bounded-YAML',
        endpoint: origin,
        device,
        sessionAttach: 'forceAppLaunch=false;shouldTerminateApp=false',
        gestureScope:
          'W3C physical touch movement uses YAML duration milliseconds. Animation waits use bounded fixed pause, not measured animation completion.',
      },
      null,
      2,
    ) + '\n',
  );
  const flow = new PhysicalIosFlow(
    request,
    requiredString(process.env.PROFILE_MARK_URL, 'local mark URL'),
    requiredString(process.env.PROFILE_SESSION_TOKEN, 'local mark token'),
    directory,
  );
  try {
    await flow.attach(identity.pid);
    const attachedProcessesPath = join(directory, 'selected-processes-after-attach.json');
    execFileSync(
      'xcrun',
      ['devicectl', 'device', 'info', 'processes', '--device', device, '--json-output', attachedProcessesPath],
      { encoding: 'utf8', timeout: 20_000 },
    );
    assertDeviceProcessPid(
      expectedAppPid,
      iosProcessPid(JSON.parse(readFileSync(attachedProcessesPath, 'utf8')) as unknown, 'BoardseshPerf'),
    );
    await flow.run(resolve(filename));
  } finally {
    await flow.detach();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhysicalIosFlow(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
