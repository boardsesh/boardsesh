/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { adbPath, resolveAndroidHome } from './lib/android-sdk';
import { acquireSimulatorLease } from './lib/ios-simulator-lease';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PHASES = ['contention', 'prepare-reload', 'verify-reload'] as const;
export const MAX_RECEIPT_BYTES = 256 * 1024;
type Phase = (typeof PHASES)[number];
export type QaReceipt = Record<string, unknown> & {
  runId: string;
  phase: Phase;
  status: 'passed' | 'failed' | 'holding' | 'reloaded';
  runtimeId: string;
};

export type QaOptions = {
  platform: 'android' | 'ios';
  device: string;
  appPath: string;
  outputDir: string;
  metroPort: number;
  timeoutMs: number;
  rows: number;
};

export function parseQaOptions(args: readonly string[]): QaOptions {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const argument = args[index + 1];
    if (
      !['--platform', '--device', '--app-path', '--output-dir', '--metro-port', '--timeout-ms', '--rows'].includes(flag)
    ) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (!argument || argument.startsWith('--') || options[flag]) throw new Error(`Invalid argument: ${flag}`);
    options[flag] = argument;
  }
  const platform = options['--platform'];
  if (platform !== 'android' && platform !== 'ios') throw new Error('--platform must be android or ios');
  const device = options['--device'];
  if (!device || (platform === 'ios' ? !/^[a-f\d-]{36}$/i.test(device) : !/^emulator-\d+$/.test(device))) {
    throw new Error('Use an explicit simulator UDID or emulator serial; physical installs are excluded');
  }
  if (!options['--app-path'] || !options['--output-dir']) throw new Error('--app-path and --output-dir are required');
  const metroPort = Number(options['--metro-port'] ?? process.env.BOARDSESH_METRO_PORT ?? '8095');
  const timeoutMs = Number(options['--timeout-ms'] ?? '600000');
  const rows = Number(options['--rows'] ?? '369000');
  if (!Number.isInteger(metroPort) || metroPort < 1024 || metroPort > 65535) throw new Error('Invalid Metro port');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('Invalid timeout');
  if (!Number.isSafeInteger(rows) || rows < 1000 || rows > 500000) throw new Error('Invalid fixture row count');
  return {
    platform,
    device,
    appPath: resolve(options['--app-path']),
    outputDir: resolve(options['--output-dir']),
    metroPort,
    timeoutMs,
    rows,
  };
}

export function parseQaReceipt(body: string, runId: string): QaReceipt {
  if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error('Receipt too large');
  const receipt: unknown = JSON.parse(body);
  if (typeof receipt !== 'object' || receipt === null) throw new Error('Invalid receipt');
  const fields = receipt as Record<string, unknown>;
  if (
    fields.runId !== runId ||
    !PHASES.includes(fields.phase as Phase) ||
    !['passed', 'failed', 'holding', 'reloaded'].includes(String(fields.status)) ||
    typeof fields.runtimeId !== 'string' ||
    !fields.runtimeId
  )
    throw new Error('Receipt identity or phase mismatch');
  return fields as QaReceipt;
}

export function assertRuntimeReplacement(holding: QaReceipt, verified: QaReceipt, beforePid: string, afterPid: string) {
  if (!/^\d+$/.test(beforePid) || beforePid !== afterPid) throw new Error('Native process changed across reload');
  if (holding.runtimeId === verified.runtimeId) throw new Error('JavaScript runtime did not change');
  if (holding.runId !== verified.runId || verified.status !== 'passed') throw new Error('Reload verification failed');
  if (typeof holding.databaseName !== 'string' || holding.databaseName !== verified.databaseName) {
    throw new Error('Reload verification used a different database');
  }
}

function command(binary: string, args: readonly string[]): string {
  return execFileSync(binary, [...args], { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }).trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(250);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

export async function waitForQaReceipt(
  receipts: readonly QaReceipt[],
  phase: Phase,
  status: QaReceipt['status'],
  timeoutMs: number,
  reopen?: () => void,
): Promise<QaReceipt> {
  let nextReopenAt = 0;
  return waitFor(() => {
    const failure = receipts.find((receipt) => receipt.status === 'failed');
    if (failure) throw new Error(`Harness failed: ${JSON.stringify(failure)}`);
    const receipt = receipts.find((candidate) => candidate.phase === phase && candidate.status === status);
    if (!receipt && reopen && Date.now() >= nextReopenAt) {
      // Inspector registration can precede JS linking listeners, and Android
      // may retain the original dev-client URL across a reload. Re-deliver the
      // command until acknowledged; the per-runtime cache prevents duplicates.
      reopen();
      nextReopenAt = Date.now() + 2000;
    }
    return receipt;
  }, timeoutMs);
}

export async function reloadMetroRuntime(metroPort: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${metroPort}/message`, {
      origin: `http://localhost:${metroPort}`,
    });
    const timeout = setTimeout(() => finish(new Error('Metro reload socket timed out')), 10_000);
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.terminate();
      if (error) reject(error);
      else done();
    }
    socket.on('error', finish);
    socket.on('open', () =>
      socket.send(JSON.stringify({ version: 2, id: 'qa-peers', target: 'server', method: 'getpeers' })),
    );
    socket.on('message', (body) => {
      try {
        const bytes = Array.isArray(body)
          ? Buffer.concat(body)
          : body instanceof ArrayBuffer
            ? Buffer.from(body)
            : body;
        const message = JSON.parse(bytes.toString('utf8')) as { id?: string; result?: Record<string, unknown> };
        if (message.id !== 'qa-peers') return;
        if (!message.result || Object.keys(message.result).length !== 1) {
          finish(new Error('Metro must have exactly one connected app before reload'));
          return;
        }
        socket.send(JSON.stringify({ version: 2, method: 'reload' }), (error) => finish(error ?? undefined));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export async function runOfflineWriteQa(options: QaOptions): Promise<void> {
  mkdirSync(options.outputDir, { recursive: true });
  const runId = randomUUID();
  const receipts: QaReceipt[] = [];
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    sourceSha: command('git', ['-C', ROOT, 'rev-parse', 'HEAD']),
    sourceDirty: command('git', ['-C', ROOT, 'status', '--porcelain']).length > 0,
    startedAt: new Date().toISOString(),
    platform: options.platform,
    device: options.device,
    appPath: options.appPath,
    evidenceKind: 'development-client',
    requestedFixtureRows: options.rows,
    receivingReleaseQualified: false,
    receipts,
    status: 'failed',
  };
  const receiptPath = join(options.outputDir, `${runId}-receipts.jsonl`);
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/receipt') {
      response.writeHead(404).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error('Receipt too large');
      }
      const receipt = parseQaReceipt(body, runId);
      receipts.push(receipt);
      appendFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
      response.writeHead(200).end('ok');
    } catch {
      response.writeHead(400).end('Invalid receipt');
    }
  });
  let releaseLease: (() => void) | undefined;
  let receiptPort: number | undefined;
  const adb = options.platform === 'android' ? adbPath(resolveAndroidHome()) : '';
  const adbCommand = (args: readonly string[]) => command(adb, ['-s', options.device, ...args]);
  const simCommand = (args: readonly string[]) => command('xcrun', ['simctl', ...args]);
  let bundleId = '';
  const openUrl = (url: string) =>
    options.platform === 'android'
      ? adbCommand(['shell', `am start -a android.intent.action.VIEW -d '${url}' -p '${bundleId}'`])
      : simCommand(['openurl', options.device, url]);
  const readPid = () => {
    if (options.platform === 'android') return adbCommand(['shell', 'pidof', bundleId]);
    const processLine = simCommand(['spawn', options.device, 'launchctl', 'list'])
      .split('\n')
      .find((line) => line.includes(`UIKitApplication:${bundleId}[`));
    return processLine?.trim().split(/\s+/)[0] ?? '';
  };
  const phaseReceipt = (phase: Phase, status: QaReceipt['status']) =>
    waitForQaReceipt(receipts, phase, status, options.timeoutMs, () => openPhase(phase));
  const openPhase = (phase: Phase) =>
    openUrl(
      `com.boardsesh.app://dev/integration/offline-writes?runId=${runId}&phase=${phase}&receiptPort=${receiptPort}&rows=${options.rows}`,
    );
  try {
    if (!existsSync(options.appPath)) throw new Error(`Missing dev-client artifact: ${options.appPath}`);
    if (options.platform === 'android') {
      const toolsDir = join(resolveAndroidHome(), 'build-tools');
      const aapt = readdirSync(toolsDir)
        .sort()
        .reverse()
        .map((version) => join(toolsDir, version, 'aapt'))
        .find((candidate) => existsSync(candidate));
      if (!aapt) throw new Error('Android build-tools/aapt is required to verify the APK identity');
      const badging = command(aapt, ['dump', 'badging', options.appPath]);
      bundleId = /^package: name='([^']+)'/m.exec(badging)?.[1] ?? '';
      if (bundleId !== 'com.boardsesh.app.dev')
        throw new Error('Only the Android development package may be installed');
      summary.binarySha256 = createHash('sha256').update(readFileSync(options.appPath)).digest('hex');
      summary.apkBadging = badging.split('\n').filter((line) => /^(package:|native-code:|sdkVersion:)/.test(line));
      if (adbCommand(['get-state']) !== 'device') throw new Error('Selected Android emulator is not ready');
      adbCommand(['install', '-r', options.appPath]);
      summary.osVersion = adbCommand(['shell', 'getprop', 'ro.build.version.release']);
    } else {
      if (process.platform !== 'darwin' || !statSync(options.appPath).isDirectory())
        throw new Error('iOS requires a simulator .app on macOS');
      const lease = acquireSimulatorLease(options.device, ROOT);
      releaseLease = () => lease.release();
      bundleId = command('/usr/libexec/PlistBuddy', [
        '-c',
        'Print:CFBundleIdentifier',
        join(options.appPath, 'Info.plist'),
      ]);
      if (bundleId !== 'com.boardsesh.app') throw new Error('Unexpected iOS simulator bundle identity');
      const executable = command('/usr/libexec/PlistBuddy', [
        '-c',
        'Print:CFBundleExecutable',
        join(options.appPath, 'Info.plist'),
      ]);
      summary.binarySha256 = createHash('sha256')
        .update(readFileSync(join(options.appPath, executable)))
        .digest('hex');
      simCommand(['install', options.device, options.appPath]);
    }
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No receipt listener address');
    receiptPort = address.port;
    if (options.platform === 'android') {
      for (const port of [options.metroPort, receiptPort]) adbCommand(['reverse', `tcp:${port}`, `tcp:${port}`]);
    }
    const metroResponse = await fetch(`http://127.0.0.1:${options.metroPort}/status`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!(await metroResponse.text()).includes('packager-status:running'))
      throw new Error('Start dev:mobile with the offline-write QA environment first');
    openUrl(
      `exp+boardsesh://expo-development-client/?url=${encodeURIComponent(`http://localhost:${options.metroPort}`)}`,
    );
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${options.metroPort}/json/list`, {
        signal: AbortSignal.timeout(5000),
      });
      const contexts: unknown = await response.json();
      return Array.isArray(contexts) && contexts.length > 0 ? true : undefined;
    }, options.timeoutMs);
    await phaseReceipt('contention', 'passed');
    const beforePid = readPid();
    if (!/^\d+$/.test(beforePid)) throw new Error('Cannot identify one native process before reload');
    summary.pidBeforeReload = beforePid;
    const holding = await phaseReceipt('prepare-reload', 'holding');
    if (options.platform === 'android') adbCommand(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    else simCommand(['launch', options.device, 'com.apple.Preferences']);
    await delay(1500);
    openPhase('prepare-reload');
    await delay(500);
    summary.backgroundedWithOpenWriter = true;
    await reloadMetroRuntime(options.metroPort);
    await phaseReceipt('prepare-reload', 'reloaded');
    const verified = await phaseReceipt('verify-reload', 'passed');
    const afterPid = readPid();
    summary.pidAfterReload = afterPid;
    assertRuntimeReplacement(holding, verified, beforePid, afterPid);
    summary.status = 'passed';
    console.log(`[offline-write-qa] passed ${runId}; native PID ${afterPid} survived reload`);
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    // Restrict native logs to this test app's process; never collect a device's
    // unrelated application logs when startup fails before a PID is known.
    try {
      const pid = readPid();
      if (/^\d+$/.test(pid)) {
        const nativeLog =
          options.platform === 'android'
            ? adbCommand(['logcat', '-d', `--pid=${pid}`, '-t', '400'])
            : simCommand([
                'spawn',
                options.device,
                'log',
                'show',
                '--last',
                '5m',
                '--style',
                'compact',
                '--predicate',
                `processIdentifier == ${pid}`,
              ]);
        writeFileSync(join(options.outputDir, `${runId}-native.log`), nativeLog);
      }
    } catch {
      summary.nativeLogUnavailable = true;
    }
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    writeFileSync(join(options.outputDir, `${runId}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    if (options.platform === 'android' && receiptPort) {
      try {
        adbCommand(['reverse', '--remove', `tcp:${receiptPort}`]);
      } catch {
        /* Device may have disconnected. */
      }
    }
    releaseLease?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOfflineWriteQa(parseQaOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
