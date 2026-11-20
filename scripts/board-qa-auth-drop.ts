/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { abortRun, Evidence, lease, QaFailure, requireRunning, runAbortSignal } from './board-qa/evidence';
import { Fixture, type AuthDropResult } from './board-qa/fixture';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATOR_TIMEOUT_MS = 300_000;

export function waitForEnter(
  signal: AbortSignal,
  input: Readable = process.stdin,
  timeoutMs = OPERATOR_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const reader = createInterface({ input, terminal: false });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupted);
      reader.removeListener('close', closed);
      reader.close();
      input.pause();
      if (error) reject(error);
      else resolveReady();
    };
    const interrupted = () =>
      finish(new QaFailure('Auth-drop interrupted; no further command will be sent', 'blocked'));
    const closed = () =>
      finish(new QaFailure('Input closed before confirmation; auth-drop was not requested', 'blocked'));
    const timer = setTimeout(
      () => finish(new QaFailure('No confirmation within 300 seconds; auth-drop was not requested', 'blocked')),
      timeoutMs,
    );
    reader.once('line', (line) =>
      finish(
        line.trim()
          ? new QaFailure('Confirmation requires Enter alone; auth-drop was not requested', 'blocked')
          : undefined,
      ),
    );
    reader.once('close', closed);
    signal.addEventListener('abort', interrupted, { once: true });
    if (signal.aborted) interrupted();
  });
}

type AuthDropFixture = Pick<Fixture, 'open' | 'request' | 'start' | 'authDrop' | 'close'>;

export async function runAuthDrop(
  fixture: AuthDropFixture,
  boardUuid: string,
  evidence: Evidence,
  confirmConnected: () => Promise<void>,
  log: (message: string) => void = console.log,
): Promise<AuthDropResult> {
  try {
    await fixture.open();
    const before = await fixture.request('status', undefined, true);
    if (before.runId || before.boards.some((board) => board.connections > 0))
      throw new QaFailure('Fixture is busy; disconnect all fixture phones before starting this helper', 'blocked');
    const board = before.boards.find((entry) => entry.uuid === boardUuid);
    if (!board) throw new QaFailure('Fixture does not contain the selected board UUID', 'blocked');
    if (!board.activeConnections)
      throw new QaFailure('Auth-drop requires active connection generations; update fixture firmware', 'blocked');
    requireRunning();
    await fixture.start();
    log(`Fixture lease acquired. Connect the phone to board ${boardUuid} now.`);
    log('When the app shows connected, press Enter within 300 seconds to request one reason-5 disconnect.');
    await confirmConnected();
    requireRunning();
    const result = await fixture.authDrop(boardUuid);
    evidence.save('auth-drop.json', { boardUuid, ...result, phoneOutcome: 'not-observed' });
    log(
      `GAP accepted the one-shot command (return code 0, handle ${result.connectionHandle}, generation ${result.connectionGeneration}). Android status and app UI remain unverified.`,
    );
    return result;
  } finally {
    // End releases the firmware lease; it does not issue another BLE drop.
    await fixture.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((argument) => argument !== '--'),
    options: {
      port: { type: 'string' },
      board: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'vp run qa:boards:auth-drop --port PATH --board UUID [--output DIR]\nStart with every fixture phone disconnected. After the lease is acquired, connect one phone and press Enter. Sends one fixed reason-5 GAP termination, with no retry. This does not reproduce a PIN challenge or prove an Android status/UI result.',
    );
    return 0;
  }
  if (!values.port || !values.board || !UUID.test(values.board))
    throw new QaFailure('Provide --port PATH and --board UUID; see --help', 'blocked');
  if (process.env.CI || !process.stdin.isTTY)
    throw new QaFailure('Auth-drop requires a local interactive terminal', 'blocked');
  const runId = randomUUID();
  const evidence = new Evidence(resolve(values.output ?? join('.boardsesh', 'board-qa-runs', runId)));
  const fixture = new Fixture(values.port, runId, evidence);
  const interrupted = () => {
    abortRun();
  };
  let release: (() => void) | undefined;
  try {
    release = lease([values.port]);
    process.on('SIGINT', interrupted);
    process.on('SIGTERM', interrupted);
    evidence.save('run.json', {
      schemaVersion: 1,
      runId,
      action: 'auth-drop',
      port: values.port,
      boardUuid: values.board,
    });
    await runAuthDrop(fixture, values.board, evidence, () => waitForEnter(runAbortSignal()));
    console.log(`Fixture lease released. Evidence: ${evidence.directory}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.event('auth-drop-failed', { message });
    console.error(`[qa:boards:auth-drop] ${message}\nEvidence: ${evidence.directory}`);
    return error instanceof QaFailure && error.kind === 'blocked' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(`[qa:boards:auth-drop] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = error instanceof QaFailure && error.kind === 'blocked' ? 2 : 1;
    },
  );
}
