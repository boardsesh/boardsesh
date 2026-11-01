/// <reference types="node" />
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EXAMPLE_CONFIG, loadConfig, loadPasswords } from './board-qa/config';
import { Evidence, lease, QaFailure, abortRun, runFailure, abortOnObserverFailure } from './board-qa/evidence';
import { command, drivers, cancelCommands } from './board-qa/drivers';
import { record } from './board-qa/config';
import { Backend } from './board-qa/backend';
import { Fixture } from './board-qa/fixture';
import { Suite } from './board-qa/suite';

export const PHYSICAL_SCOPES = {
  solo: { singleBoard: 6, mixedBoards: 6, crewSessions: 0, total: 12 },
  mixed: { singleBoard: 0, mixedBoards: 6, crewSessions: 0, total: 6 },
  sessions: { singleBoard: 0, mixedBoards: 0, crewSessions: 6, total: 6 },
  all: { singleBoard: 6, mixedBoards: 6, crewSessions: 6, total: 18 },
} as const;
export async function runPhysicalScope(
  action: keyof typeof PHYSICAL_SCOPES,
  suite: Pick<Suite, 'solo' | 'mixedBoards' | 'sessions'>,
): Promise<void> {
  if (action === 'solo' || action === 'all') await suite.solo(); // solo includes mixedBoards.
  if (action === 'mixed') await suite.mixedBoards();
  if (action === 'sessions' || action === 'all') await suite.sessions();
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv.filter((argument) => argument !== '--'),
    allowPositionals: true,
    options: {
      config: { type: 'string', default: '.boardsesh/board-qa.json' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  const action = positionals[0] ?? 'doctor';
  if (values.help) {
    console.log(
      'vp run qa:boards -- init|doctor|solo|mixed|sessions|all [--config FILE] [--output DIR]\nLocal physical iPhone + Android QA only. init writes a nonsecret example; doctor never acquires BLE or starts a session.\nScopes: solo = 6 single-board + 6 mixed cases; mixed = 6 cross-board cases; sessions = 6 crew cases; all = 18 cases.',
    );
    return 0;
  }
  if (positionals.length > 1 || !['init', 'doctor', 'solo', 'mixed', 'sessions', 'all'].includes(action))
    throw new Error('Choose init, doctor, solo, mixed, sessions, or all');
  const configFile = resolve(values.config ?? '.boardsesh/board-qa.json');
  if (action === 'init') {
    mkdirSync(resolve('.boardsesh'), { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      `[qa:boards] Configuration written to ${configFile}. Fill device IDs and private credentials before doctor.`,
    );
    return 0;
  }
  if (process.env.CI) throw new QaFailure('Physical QA runs are local only; CI is not supported', 'blocked');
  if (!existsSync(configFile))
    throw new QaFailure('No local configuration. Run vp run qa:boards -- init first.', 'blocked');
  const config = loadConfig(configFile);
  const runId = randomUUID();
  const evidence = new Evidence(resolve(values.output ?? join('.boardsesh', 'board-qa-runs', runId)));
  const passwords = loadPasswords(config.credentialsFile, [config.phones.ios.email, config.phones.android.email]);
  Object.values(passwords).forEach((password) => evidence.secret(password));
  const backend = new Backend(config, evidence);
  abortOnObserverFailure(backend, cancelCommands, evidence);
  const fixture = new Fixture(config.serialPort, runId, evidence);
  let phoneDrivers: Awaited<ReturnType<typeof drivers>> | undefined;
  let suite: Suite | undefined;
  let release: (() => void) | undefined;
  let exitCode = 0;
  let reportedFailure = false;
  const interrupted = () => {
    abortRun();
    void cancelCommands();
  };
  try {
    release = lease([config.serialPort, config.phones.ios.id, config.phones.android.id]);
    process.once('SIGINT', interrupted);
    process.once('SIGTERM', interrupted);
    evidence.save('run.json', {
      schemaVersion: 1,
      runId,
      action,
      sourceRevision: (await command('git', ['rev-parse', 'HEAD'])).trim(),
      workingTree: await command('git', ['status', '--short']),
      devices: config.phones,
      fixturePort: config.serialPort,
    });
    await evidence.scenario('preflight/tools-and-devices', [], async () => {
      const devices = await command(config.adb, ['devices', '-l']);
      if (
        !devices.split('\n').some((line) => {
          const fields = line.trim().split(/\s+/);
          return (
            fields[0] === config.phones.android.id &&
            fields[1] === 'device' &&
            fields.some((field) => field.startsWith('usb:'))
          );
        })
      )
        throw new QaFailure('Configured physical Android is absent, unauthorized, or not USB-connected', 'blocked');
      const inventoryPath = join(evidence.directory, 'ios-inventory.private.json');
      await command('xcrun', ['devicectl', 'list', 'devices', '--json-output', inventoryPath]);
      const iosDevices = record(record(JSON.parse(readFileSync(inventoryPath, 'utf8')) as unknown).result).devices;
      if (
        !Array.isArray(iosDevices) ||
        !iosDevices.some((candidate) => {
          const device = record(candidate);
          const properties = record(device.properties);
          const hardware = record(properties.hardware);
          const connection = record(properties.connection);
          return (
            hardware.udid === config.phones.ios.id &&
            hardware.reality === 'physical' &&
            connection.transportType === 'wired' &&
            connection.state === 'connected'
          );
        })
      )
        throw new QaFailure('Configured iPhone must be connected and trusted over USB', 'blocked');
      await command('maestro', ['--version']);
      const androidPackage = await command(config.adb, [
        '-s',
        config.phones.android.id,
        'shell',
        'pm',
        'path',
        config.phones.android.appId,
      ]);
      if (!androidPackage.includes('package:'))
        throw new QaFailure('Configured Android app is not installed', 'blocked');
      const androidMetadata = await command(config.adb, [
        '-s',
        config.phones.android.id,
        'shell',
        'dumpsys',
        'package',
        config.phones.android.appId,
      ]);
      const iosAppsPath = join(evidence.directory, 'ios-app.private.json');
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
        iosAppsPath,
      ]);
      const iosApps = record(record(JSON.parse(readFileSync(iosAppsPath, 'utf8')) as unknown).result).apps;
      if (!Array.isArray(iosApps) || iosApps.length !== 1)
        throw new QaFailure('Configured iPhone app is not installed uniquely', 'blocked');
      const iosApp = record(iosApps[0]);
      evidence.save('native-versions.json', {
        android: {
          appId: config.phones.android.appId,
          versionName: androidMetadata.match(/versionName=(\S+)/)?.[1] ?? null,
          versionCode: androidMetadata.match(/versionCode=(\d+)/)?.[1] ?? null,
        },
        ios: {
          appId: config.phones.ios.appId,
          version: iosApp.version,
          build: iosApp.bundleVersion,
          developerBuild: iosApp.builtByDeveloper,
        },
      });
    });
    await evidence.scenario('preflight/accounts-and-catalog', [], async () => {
      for (const phone of Object.values(config.phones)) await backend.signIn(phone.email, passwords[phone.email]);
      if (new Set(backend.users.values()).size !== 2)
        throw new QaFailure('The configured emails resolved to the same account', 'blocked');
    });
    const boards = await backend.catalog();
    await evidence.scenario('preflight/physical-drivers', [], async () => {
      phoneDrivers = await drivers(config, evidence);
    });
    await evidence.scenario('preflight/fixture', [], async () => {
      await fixture.open();
      const status = await fixture.request('status', undefined, true);
      if (status.runId || status.boards.some((board) => board.connections))
        throw new QaFailure('Fixture is already connected or leased', 'blocked');
      if (boards.some((board) => !status.boards.some((candidate) => candidate.uuid === board.uuid)))
        throw new QaFailure('Fixture is advertising another gym', 'blocked');
    });
    if (action !== 'doctor') {
      if (!phoneDrivers) throw new Error('Driver setup did not complete');
      await backend.observe(boards);
      suite = new Suite(config, phoneDrivers, fixture, backend, boards, evidence);
      await evidence.scenario('prepare/accounts-and-real-history-dwell', [], () => suite!.prepare());
      if (action === 'solo' || action === 'mixed' || action === 'sessions' || action === 'all') {
        evidence.event('selected-scope', { action, ...PHYSICAL_SCOPES[action] });
        await runPhysicalScope(action, suite);
      }
    }
  } catch (error) {
    const cause = runFailure() ?? error;
    await suite?.failureArtifacts();
    const message = evidence.redact(cause instanceof Error ? cause.message : String(cause));
    evidence.event('run-error', { message });
    reportedFailure = true;
    console.error(`[qa:boards] ${message}\nEvidence: ${evidence.directory}`);
    exitCode = cause instanceof QaFailure && cause.kind === 'blocked' ? 2 : 1;
  } finally {
    await cancelCommands();
    backend.close();
    try {
      await fixture.close();
    } catch {
      evidence.event('cleanup-failed', {
        target: 'fixture',
        note: 'QA lease expires after 30 seconds without owner heartbeat',
      });
    }
    if (phoneDrivers)
      for (const phone of Object.values(phoneDrivers)) {
        try {
          await phone.close();
        } catch {
          evidence.event('cleanup-failed', { target: 'phone-driver' });
        }
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
      console.error(`[qa:boards] ${evidence.redact(aborted.message)}\nEvidence: ${evidence.directory}`);
    }
  }
  if (exitCode === 0)
    console.log(
      `[qa:boards] ${action === 'doctor' ? 'Preflight' : 'Physical scenarios'} passed. Evidence: ${evidence.directory}`,
    );
  return exitCode;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}
