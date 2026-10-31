/// <reference types="node" />
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadPasswords, record, type QaConfig } from './board-qa/config';
import { Backend } from './board-qa/backend';
import { AndroidDriver, IosDriver, command, cancelCommands, type Driver } from './board-qa/drivers';
import { Evidence, QaFailure, lease, abortRun, runFailure, abortOnObserverFailure } from './board-qa/evidence';
import { Fixture } from './board-qa/fixture';
import { SimulatorPeerSuite, SIMULATOR_PEER_UNRUN } from './board-qa/fallback-suite';

export function simulatorConfig(config: QaConfig, peer: string, appId?: string): QaConfig {
  if (!/^emulator-\d+$/.test(peer)) throw new QaFailure('Select an explicit Android emulator serial', 'blocked');
  if (appId && !/^[A-Za-z][A-Za-z0-9_.]+$/.test(appId)) throw new Error('Invalid emulator app ID');
  return {
    ...config,
    phones: {
      ios: config.phones.ios,
      android: { ...config.phones.android, id: peer, appId: appId ?? config.phones.android.appId },
    },
  };
}
export function requireEmulator(devices: string, serial: string, qemu: string): void {
  if (
    !/^emulator-\d+$/.test(serial) ||
    qemu.trim() !== '1' ||
    !devices.split('\n').some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[0] === serial && fields[1] === 'device' && !fields.some((field) => field.startsWith('usb:'));
    })
  )
    throw new QaFailure('Configured peer is not the exact ready Android emulator', 'blocked');
}
export function requireNormalMetro(environment: string): void {
  for (const name of ['EXPO_PUBLIC_SCREENSHOT_MODE', 'EXPO_PUBLIC_SCREENSHOT_FAKE_BLE']) {
    const flag = environment.match(new RegExp(`(?:^|\\s)${name}=([^\\s]*)`))?.[1];
    if (flag !== '0') throw new QaFailure(`Peer Metro must explicitly set ${name}=0`, 'blocked');
  }
  const backend = environment.match(/(?:^|\s)EXPO_PUBLIC_BACKEND_URL=([^\s]*)/)?.[1];
  if (backend !== 'https://ws.boardsesh.com')
    throw new QaFailure('Peer Metro must use the production backend', 'blocked');
}
export function fallbackCoverage(config: QaConfig, peerEnabled = true) {
  return {
    profile: peerEnabled ? 'physical-ios-with-android-emulator-peer' : 'physical-ios-holder-only',
    allMatrixPassed: false,
    peerEnabled,
    verifiedPeer: false,
    selectedCaseCount: peerEnabled ? 9 : 6,
    participants: {
      holder: { platform: 'ios', deviceKind: 'physical', id: config.phones.ios.id, bluetoothHolder: true },
      ...(peerEnabled
        ? {
            peer: { platform: 'android', deviceKind: 'emulator', id: config.phones.android.id, bluetoothHolder: false },
          }
        : {}),
    },
    included: [
      'iPhone solo Drive/Next/Put/disconnect',
      'Private preview and board-switch isolation',
      ...(peerEnabled
        ? [
            'Foreground crew relay, clear/relight, saved history and presence',
            'Native join, roster, leave/rejoin and end',
          ]
        : []),
    ],
    boardFamilies: config.boards.map((board) => board.family),
    unrun: [
      ...SIMULATOR_PEER_UNRUN,
      ...(peerEnabled
        ? []
        : [
            'All peer UI, preview, history and presence observations',
            'All crew join/leave/rejoin, roster, relay, clear/re-light and End scenarios',
          ]),
    ],
  };
}

export async function bindSimulatorMetro(
  config: QaConfig,
  port: string,
  runCommand: typeof command = command,
): Promise<string> {
  const peer = config.phones.android;
  if (
    !/^emulator-\d+$/.test(peer.id) ||
    !/^[A-Za-z][A-Za-z0-9_.]+$/.test(peer.appId) ||
    !/^[a-z][a-z0-9+.-]*$/i.test(peer.scheme) ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65535
  )
    throw new QaFailure('Invalid exact emulator Metro binding', 'blocked');
  const mapping = `tcp:${port}`;
  const existing = (await runCommand(config.adb, ['-s', peer.id, 'reverse', '--list']))
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.at(-2) === mapping);
  if (existing.some((fields) => fields.at(-1) !== mapping))
    throw new QaFailure('Emulator Metro port already forwards to another destination', 'blocked');
  if (!existing.length) await runCommand(config.adb, ['-s', peer.id, 'reverse', '--no-rebind', mapping, mapping]);
  // Only restart the remote emulator, preserving its signed-in data. The
  // fresh development-client intent binds this process to inspected Metro.
  await runCommand(config.adb, ['-s', peer.id, 'shell', 'am', 'force-stop', peer.appId]);
  const bundleOrigin = `http://127.0.0.1:${port}`;
  const peerLink = `${peer.scheme}://expo-development-client/?url=${encodeURIComponent(bundleOrigin)}`;
  const launched = await runCommand(config.adb, [
    '-s',
    peer.id,
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `'${peerLink}'`,
    '-p',
    `'${peer.appId}'`,
  ]);
  const activityPackage = launched.match(/^\s*Activity:\s*([^/\s]+)\//m)?.[1];
  if (!/\bStatus:\s*ok\b/.test(launched) || /\bError:/.test(launched) || activityPackage !== peer.appId)
    throw new QaFailure('Emulator development-client did not accept the exact Metro launch', 'blocked');
  return bundleOrigin;
}

export async function verifySimulatorPeer(suite: Pick<SimulatorPeerSuite, 'identity'>, peer: Driver): Promise<void> {
  try {
    // Native am-start success precedes React navigation. Observe existing app
    // content before sending the account URI; never replace this with a delay.
    await peer.flow('wait-app-ready');
  } catch (error) {
    if (error instanceof QaFailure && error.kind === 'failed')
      throw new QaFailure('Normal simulator app navigation did not become ready', 'blocked');
    throw error;
  }
  await suite.identity('android');
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv.filter((argument) => argument !== '--'),
    allowPositionals: true,
    options: {
      config: { type: 'string', default: '.boardsesh/board-qa.json' },
      peer: { type: 'string' },
      'peer-app-id': { type: 'string' },
      'metro-pid': { type: 'string' },
      'metro-url': { type: 'string', default: 'http://127.0.0.1:8179' },
      output: { type: 'string' },
      'holder-only': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'vp run qa:boards:simulator-peer -- doctor|run (--holder-only | --peer emulator-SERIAL --metro-pid PID) [--config FILE] [--metro-url http://127.0.0.1:8179] [--peer-app-id APP_ID] [--output DIR]\nSeparate local foreground profile: physical iPhone holder + optional Android emulator remote peer. --holder-only runs six iPhone cases without any peer/Metro access. Sign in normally before running. Existing qa:boards all is unchanged.',
    );
    return 0;
  }
  const action = positionals[0] ?? 'doctor';
  if (positionals.length > 1 || !['doctor', 'run'].includes(action)) throw new Error('Choose doctor or run');
  if (process.env.CI) throw new QaFailure('Simulator-peer hardware QA is local only', 'blocked');
  const peerEnabled = !values['holder-only'];
  const baseConfig = loadConfig(resolve(values.config!));
  const config = peerEnabled ? simulatorConfig(baseConfig, values.peer ?? '', values['peer-app-id']) : baseConfig;
  const metroPid = Number(values['metro-pid']);
  if (peerEnabled && (!Number.isSafeInteger(metroPid) || metroPid <= 0))
    throw new Error('Select the actual listening Metro PID');
  const metro = peerEnabled ? new URL(values['metro-url']!) : undefined;
  if (
    metro &&
    (metro.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(metro.hostname) ||
      metro.username ||
      metro.password ||
      metro.pathname !== '/' ||
      metro.search ||
      metro.hash)
  )
    throw new Error('Use the dedicated peer Metro loopback origin');
  const runId = randomUUID();
  const evidence = new Evidence(resolve(values.output ?? join('.boardsesh/board-qa-runs', runId)));
  const coverage = fallbackCoverage(config, peerEnabled);
  evidence.save('coverage.json', { ...coverage, selectedScopePassed: false, action });
  const passwords = loadPasswords(
    config.credentialsFile,
    (peerEnabled ? Object.values(config.phones) : [config.phones.ios]).map((phone) => phone.email),
  );
  Object.values(passwords).forEach((password) => evidence.secret(password));
  const backend = new Backend(config, evidence);
  abortOnObserverFailure(backend, cancelCommands, evidence);
  const fixture = new Fixture(config.serialPort, runId, evidence);
  const phones: { ios: Driver; android?: Driver } = {
    ios: new IosDriver(config.phones.ios, evidence),
    ...(peerEnabled ? { android: new AndroidDriver(config.phones.android, config.adb, evidence) } : {}),
  };
  let suite: SimulatorPeerSuite | undefined;
  let release: (() => void) | undefined;
  let exitCode = 0;
  let completedScope = false;
  let verifiedPeer = false;
  let reportedFailure = false;
  const interrupted = () => {
    abortRun();
    void cancelCommands();
  };
  try {
    release = lease([config.serialPort, ...Object.values(phones).map((phone) => phone.phone.id)]);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    evidence.save('run.json', {
      schemaVersion: 1,
      runId,
      action,
      ...coverage,
      sourceRevision: (await command('git', ['rev-parse', 'HEAD'])).trim(),
      workingTree: await command('git', ['status', '--short']),
    });
    await evidence.scenario(
      peerEnabled ? 'fallback/preflight/native-devices-and-normal-metro' : 'fallback/preflight/physical-ios-device',
      [],
      async () => {
        if (peerEnabled) {
          const devices = await command(config.adb, ['devices', '-l']);
          const qemu = await command(config.adb, [
            '-s',
            config.phones.android.id,
            'shell',
            'getprop',
            'ro.kernel.qemu',
          ]);
          requireEmulator(devices, config.phones.android.id, qemu);
        }
        const iosPath = join(evidence.directory, 'ios-inventory.private.json');
        await command('xcrun', ['devicectl', 'list', 'devices', '--json-output', iosPath]);
        const inventory = record(record(JSON.parse(readFileSync(iosPath, 'utf8')) as unknown).result).devices;
        if (
          !Array.isArray(inventory) ||
          !inventory.some((candidate) => {
            const properties = record(record(candidate).properties);
            const hardware = record(properties.hardware),
              connection = record(properties.connection);
            return (
              hardware.udid === config.phones.ios.id &&
              hardware.reality === 'physical' &&
              connection.transportType === 'wired' &&
              connection.state === 'connected'
            );
          })
        )
          throw new QaFailure('Physical iPhone holder must be trusted and USB-connected', 'blocked');
        let androidMetadata: string | undefined;
        if (metro) {
          // Read privately, parse allowlisted fields, and never retain the process command/environment.
          const listeners = await command('lsof', ['-nP', '-t', `-iTCP:${metro.port || '80'}`, '-sTCP:LISTEN']);
          if (!listeners.trim().split(/\s+/).includes(String(metroPid)))
            throw new QaFailure('Selected PID does not own the peer Metro listener', 'blocked');
          requireNormalMetro(await command('ps', ['eww', '-p', String(metroPid), '-o', 'command=']));
          const response = await fetch(new URL('/_boardsesh/metro-info', metro), { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new QaFailure('Dedicated peer Metro metadata unavailable', 'blocked');
          const metadata = record(await response.json());
          if (typeof metadata.rootDir !== 'string' || realpathSync(metadata.rootDir) !== realpathSync(process.cwd()))
            throw new QaFailure('Peer Metro serves another checkout', 'blocked');
          evidence.save('peer-metro.json', {
            pid: metroPid,
            origin: metro.origin,
            rootDir: metadata.rootDir,
            commitSha: metadata.commitSha,
            screenshotMode: false,
            fakeBluetooth: false,
          });
          await command('maestro', ['--version']);
          const androidApp = await command(config.adb, [
            '-s',
            config.phones.android.id,
            'shell',
            'pm',
            'path',
            config.phones.android.appId,
          ]);
          if (!androidApp.includes('package:')) throw new QaFailure('Normal emulator app is not installed', 'blocked');
          androidMetadata = await command(config.adb, [
            '-s',
            config.phones.android.id,
            'shell',
            'dumpsys',
            'package',
            config.phones.android.appId,
          ]);
        }
        const iosAppPath = join(evidence.directory, 'ios-app.private.json');
        await command('xcrun', [
          'devicectl',
          'device',
          'info',
          'apps',
          '--device',
          config.phones.ios.id,
          '--filter',
          `bundleIdentifier == "${config.phones.ios.appId}"`,
          '--json-output',
          iosAppPath,
        ]);
        const iosApps = record(record(JSON.parse(readFileSync(iosAppPath, 'utf8')) as unknown).result).apps;
        if (!Array.isArray(iosApps) || iosApps.length !== 1)
          throw new QaFailure('Unique physical iPhone app is missing', 'blocked');
        const iosApp = record(iosApps[0]);
        evidence.save('native-versions.json', {
          holder: {
            deviceKind: 'physical',
            platform: 'ios',
            appId: config.phones.ios.appId,
            version: iosApp.version,
            build: iosApp.bundleVersion,
          },
          ...(androidMetadata
            ? {
                peer: {
                  deviceKind: 'emulator',
                  platform: 'android',
                  appId: config.phones.android.appId,
                  version: androidMetadata.match(/versionName=(\S+)/)?.[1],
                  build: androidMetadata.match(/versionCode=(\d+)/)?.[1],
                },
              }
            : {}),
        });
      },
    );
    await evidence.scenario('fallback/preflight/accounts-and-catalog', [], async () => {
      for (const phone of Object.values(phones)) await backend.signIn(phone.phone.email, passwords[phone.phone.email]);
      if (new Set(backend.users.values()).size !== (peerEnabled ? 2 : 1))
        throw new QaFailure('Distinct QA account IDs are required for all enabled participants', 'blocked');
    });
    const boards = await backend.catalog();
    suite = new SimulatorPeerSuite(config, phones, fixture, backend, boards, evidence, peerEnabled);
    await evidence.scenario('fallback/preflight/drivers-and-launched-accounts', [], async () => {
      if (metro) {
        const bundleOrigin = await bindSimulatorMetro(config, metro.port || '80');
        evidence.event('peer-metro-binding', {
          deviceKind: 'emulator',
          device: config.phones.android.id,
          appId: config.phones.android.appId,
          bundleOrigin,
          metroPid,
        });
      }
      await (phones.ios as IosDriver).attach();
      await suite!.identity('ios');
      if (peerEnabled) {
        if (!phones.android) throw new Error('Enabled peer driver is absent');
        await verifySimulatorPeer(suite!, phones.android);
        verifiedPeer = true;
      }
    });
    await evidence.scenario('fallback/preflight/physical-fixture', [], async () => {
      await fixture.open();
      const status = await fixture.request('status', undefined, true);
      if (
        status.runId ||
        status.boards.some((board) => board.connections) ||
        boards.some((board) => !status.boards.some((candidate) => candidate.uuid === board.uuid))
      )
        throw new QaFailure('Fixture is busy or does not contain all exact saved walls', 'blocked');
    });
    if (action === 'run') {
      await backend.observe(boards);
      await evidence.scenario('fallback/prepare/real-history-dwell', [], () => suite!.prepare());
      await suite.solo();
      await suite.isolation();
      if (peerEnabled) await suite.sessions();
      completedScope = true;
    }
  } catch (error) {
    const cause = runFailure() ?? error;
    await suite?.failureArtifacts();
    const message = evidence.redact(cause instanceof Error ? cause.message : String(cause));
    evidence.event('run-error', { message });
    reportedFailure = true;
    console.error(`[qa:boards:simulator-peer] ${message}\nEvidence: ${evidence.directory}`);
    exitCode = cause instanceof QaFailure && cause.kind === 'blocked' ? 2 : 1;
  } finally {
    await cancelCommands();
    try {
      await suite?.cleanup();
    } catch {
      exitCode = 1;
      evidence.event('cleanup-failed', {
        target: 'physical-link',
        note: 'Do not reset app data or restart the app with a live link; inspect recovery before ending any retained session.',
      });
    }
    try {
      await fixture.close();
    } catch {
      exitCode = 1;
      evidence.event('cleanup-failed', { target: 'fixture' });
    }
    backend.close();
    for (const phone of Object.values(phones))
      try {
        await phone.close();
      } catch {
        evidence.event('cleanup-failed', { target: 'driver' });
      }
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    release?.();
  }
  const aborted = runFailure();
  if (aborted) {
    exitCode = aborted.kind === 'blocked' ? 2 : 1;
    if (!reportedFailure) {
      evidence.event('run-error', { message: aborted.message });
      console.error(`[qa:boards:simulator-peer] ${evidence.redact(aborted.message)}\nEvidence: ${evidence.directory}`);
    }
  }
  evidence.save('coverage.json', {
    ...coverage,
    verifiedPeer,
    selectedScopePassed: completedScope && exitCode === 0,
    action,
    exitCode,
  });
  if (exitCode === 0)
    console.log(
      `[qa:boards:simulator-peer] ${action === 'doctor' ? 'Fallback prerequisites passed' : peerEnabled ? 'Selected iPhone/simulator scope passed' : 'Selected six iPhone-only cases passed'}. ${peerEnabled ? '' : 'All peer and crew coverage, '}physical Android, takeover and background coverage remain UNRUN. Evidence: ${evidence.directory}`,
    );
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('[qa:boards:simulator-peer] Invalid configuration or missing private prerequisites; run --help.');
      process.exitCode = 2;
    });
}
